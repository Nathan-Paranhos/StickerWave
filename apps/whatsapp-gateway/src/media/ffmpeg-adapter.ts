import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface FFmpegCapabilities {
  ready: boolean;
  ffmpegPath: string;
  ffprobePath: string;
  versionLine: string | null;
  encoders: {
    libwebp: boolean;
    libopus: boolean;
    opusExperimental: boolean;
    libx264: boolean;
    aac: boolean;
  };
  error?: string;
}

export interface FFmpegProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  start_time?: string;
  duration?: string;
  nb_frames?: string;
}

export interface FFmpegProbeResult {
  format?: {
    duration?: string;
    size?: string;
    format_name?: string;
  };
  streams?: FFmpegProbeStream[];
}

function resolveWindowsWingetBinary(binaryFileName: string): string | null {
  if (process.platform !== 'win32') return null;
  const localAppData = process.env.LOCALAPPDATA;
  const roots = [
    localAppData ? path.join(localAppData, 'Microsoft', 'WinGet', 'Packages') : '',
    'C:\\ffmpeg\\bin',
    'C:\\tools\\ffmpeg\\bin',
  ].filter(Boolean);

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const direct = path.join(root, binaryFileName);
    if (fs.existsSync(direct)) return direct;
    if (root.endsWith('Packages')) {
      try {
        for (const pkg of fs.readdirSync(root)) {
          if (!pkg.toLowerCase().includes('ffmpeg')) continue;
          const pkgDir = path.join(root, pkg);
          for (const sub of fs.readdirSync(pkgDir)) {
            const candidate = path.join(pkgDir, sub, 'bin', binaryFileName);
            if (fs.existsSync(candidate)) return candidate;
            const candidateFlat = path.join(pkgDir, sub, binaryFileName);
            if (fs.existsSync(candidateFlat)) return candidateFlat;
          }
        }
      } catch {
        // Ignore unreadable WinGet package subfolders.
      }
    }
  }
  return null;
}

/**
 * Resolves FFmpeg / FFprobe binaries strictly without invoking a shell:
 * 1) Explicit env override (`FFMPEG_PATH` / `FFPROBE_PATH`)
 * 2) Executable-adjacent `ffmpeg/` folder
 * 3) System `PATH` entries
 * 4) Windows WinGet / standard local install directories
 */
export function resolveMediaBinary(
  name: 'ffmpeg' | 'ffprobe',
  overridePath = '',
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = overridePath.trim() || env[`${name.toUpperCase()}_PATH`]?.trim();
  if (explicit) return explicit;

  const fileName = process.platform === 'win32' ? `${name}.exe` : name;
  const execDir = path.dirname(process.execPath);
  for (const candidate of [path.join(execDir, fileName), path.join(execDir, 'ffmpeg', fileName)]) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const pathVar = env.PATH || env.Path || '';
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }

  const wingetMatch = resolveWindowsWingetBinary(fileName);
  if (wingetMatch) return wingetMatch;

  return name;
}

export class FFmpegExecutionError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = 'FFmpegExecutionError';
  }
}

export class FFmpegAdapter {
  public readonly ffmpegPath: string;
  public readonly ffprobePath: string;
  private cachedCapabilities: FFmpegCapabilities | null = null;
  private capabilitiesInFlight: Promise<FFmpegCapabilities> | null = null;

  constructor(options: { ffmpegPath?: string; ffprobePath?: string } = {}) {
    this.ffmpegPath = resolveMediaBinary('ffmpeg', options.ffmpegPath);
    this.ffprobePath = resolveMediaBinary('ffprobe', options.ffprobePath);
  }

  async run(
    args: readonly string[],
    options: { timeoutMs?: number; signal?: AbortSignal; stdin?: Uint8Array } = {},
  ): Promise<{ stdout: Buffer; stderr: string }> {
    const { timeoutMs = 45_000, signal, stdin } = options;
    if (signal?.aborted) throw new Error('Operation aborted before starting FFmpeg.');

    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], {
        windowsHide: true,
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalStdout = 0;
      let settled = false;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve({ stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks).toString('utf8') });
      };

      const onAbort = () => {
        child.kill('SIGKILL');
        finish(new Error('FFmpeg cancelled by AbortSignal.'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new FFmpegExecutionError(`FFmpeg timed out after ${timeoutMs}ms`, Buffer.concat(stderrChunks).toString('utf8')));
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        totalStdout += chunk.length;
        if (totalStdout > MAX_BUFFER_BYTES) {
          child.kill('SIGKILL');
          finish(new FFmpegExecutionError('FFmpeg stdout exceeded memory budget.', ''));
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      child.on('error', (err) => finish(err));
      child.on('close', (code) => {
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (code !== 0) {
          finish(new FFmpegExecutionError(`FFmpeg exited with code ${code}: ${stderr.slice(0, 500)}`, stderr, code));
        } else {
          finish();
        }
      });

      if (stdin && child.stdin) {
        child.stdin.on('error', () => undefined);
        child.stdin.end(stdin);
      }
    });
  }

  async runVerbose(args: readonly string[], timeoutMs = 30_000): Promise<string> {
    try {
      const { stderr } = await execFileAsync(
        this.ffmpegPath,
        ['-hide_banner', '-nostdin', '-nostats', ...args],
        { maxBuffer: MAX_BUFFER_BYTES, timeout: timeoutMs, windowsHide: true },
      );
      return String(stderr);
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      throw new FFmpegExecutionError(e.message || 'FFmpeg verbose run failed', String(e.stderr || ''));
    }
  }

  async probe(filePath: string, timeoutMs = 15_000): Promise<FFmpegProbeResult> {
    try {
      const { stdout } = await execFileAsync(
        this.ffprobePath,
        ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath],
        { maxBuffer: MAX_BUFFER_BYTES, timeout: timeoutMs, windowsHide: true },
      );
      return JSON.parse(String(stdout)) as FFmpegProbeResult;
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      throw new FFmpegExecutionError(`FFprobe failed: ${e.message || 'unknown error'}`, String(e.stderr || ''));
    }
  }

  async checkCapabilities(forceRefresh = false): Promise<FFmpegCapabilities> {
    if (!forceRefresh && this.cachedCapabilities) {
      return this.cachedCapabilities;
    }
    if (!forceRefresh && this.capabilitiesInFlight) {
      return this.capabilitiesInFlight;
    }

    this.capabilitiesInFlight = (async (): Promise<FFmpegCapabilities> => {
      try {
        const [{ stdout: verOut }, { stdout: encOut }] = await Promise.all([
          execFileAsync(this.ffmpegPath, ['-hide_banner', '-version'], { timeout: 10_000, windowsHide: true }),
          execFileAsync(this.ffmpegPath, ['-hide_banner', '-encoders'], { maxBuffer: MAX_BUFFER_BYTES, timeout: 10_000, windowsHide: true }),
          execFileAsync(this.ffprobePath, ['-hide_banner', '-version'], { timeout: 10_000, windowsHide: true }),
        ]);
        const versionLine = String(verOut).split(/\r?\n/)[0]?.trim() || null;
        const encText = String(encOut);
        const libwebp = /\slibwebp\s/.test(encText);
        const libopus = /\slibopus\s/.test(encText);
        const opusExperimental = /\sopus\s/.test(encText);
        const libx264 = /\slibx264\s/.test(encText);
        const aac = /\saac\s/.test(encText);
        const ready = Boolean(versionLine && libwebp && (libopus || opusExperimental));

        const result: FFmpegCapabilities = {
          ready,
          ffmpegPath: this.ffmpegPath,
          ffprobePath: this.ffprobePath,
          versionLine,
          encoders: { libwebp, libopus, opusExperimental, libx264, aac },
          ...(ready ? {} : { error: 'Missing required libwebp or libopus encoder in FFmpeg build.' }),
        };
        if (ready) this.cachedCapabilities = result;
        return result;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ready: false,
          ffmpegPath: this.ffmpegPath,
          ffprobePath: this.ffprobePath,
          versionLine: null,
          encoders: { libwebp: false, libopus: false, opusExperimental: false, libx264: false, aac: false },
          error: msg,
        };
      } finally {
        this.capabilitiesInFlight = null;
      }
    })();

    return this.capabilitiesInFlight;
  }
}
