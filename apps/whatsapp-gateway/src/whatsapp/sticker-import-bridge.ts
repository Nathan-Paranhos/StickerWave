import crypto from 'node:crypto';
import type {
  AddToWhatsAppResponse,
  ClientPlatformTarget,
  EncodedSoundSticker,
  StickerMetadata,
  StickerSendJobSummary,
  WhatsAppPackManifest,
} from '@stickerwave/contracts';

export interface BuildWhatsAppPackManifestInput {
  packId?: string;
  packName?: string;
  packPublisher?: string;
  emojis?: string[];
  animatedStickerPack: boolean;
}

export function buildOfficialWhatsAppPackManifest(input: BuildWhatsAppPackManifestInput): WhatsAppPackManifest {
  const packId = (input.packId || crypto.randomUUID()).replace(/[^a-zA-Z0-9._-]/g, '_');
  const packName = (input.packName || 'StickerWave').trim().slice(0, 128) || 'StickerWave';
  const publisher = (input.packPublisher || 'Nathan Paranhos').trim().slice(0, 128) || 'Nathan Paranhos';
  const emojis = input.emojis && input.emojis.length > 0 ? input.emojis.slice(0, 3) : ['✨'];

  return {
    android_play_store_link: 'https://play.google.com/store/apps/details?id=com.whatsapp',
    ios_app_store_link: 'https://apps.apple.com/app/whatsapp-messenger/id310633997',
    sticker_packs: [
      {
        identifier: packId,
        name: packName,
        publisher,
        tray_image_file: 'tray.png',
        image_data_version: '1',
        avoid_cache: false,
        animated_sticker_pack: input.animatedStickerPack,
        publisher_website: 'https://nathan-paranhos.com.br/',
        stickers: [
          {
            image_file: '1.webp',
            emojis,
          },
        ],
      },
    ],
  };
}

export class StickerImportBridge {
  resolveAddToWhatsApp(params: {
    platform: ClientPlatformTarget;
    encodedSticker: EncodedSoundSticker;
    metadata?: Partial<StickerMetadata>;
    waConnected: boolean;
    waBotEnabled: boolean;
    botPhoneHint?: string | null;
    dispatchedJob?: StickerSendJobSummary | null;
  }): AddToWhatsAppResponse {
    const { encodedSticker, platform, waConnected, waBotEnabled, dispatchedJob } = params;
    const isSound = encodedSticker.stickerType === 'SOUND';
    const botDigits = (params.botPhoneHint || '').replace(/\D/g, '');
    const waMeUrl =
      botDigits.length >= 7
        ? `https://wa.me/${botDigits}?text=${encodeURIComponent('Olá StickerWave!')}`
        : null;

    const packManifest = isSound
      ? null
      : buildOfficialWhatsAppPackManifest({
          packId: encodedSticker.exifMeta?.packId ?? params.metadata?.packId,
          packName: encodedSticker.exifMeta?.packName ?? params.metadata?.packName ?? 'StickerWave',
          packPublisher:
            encodedSticker.exifMeta?.packPublisher ?? params.metadata?.packPublisher ?? 'Nathan Paranhos',
          emojis: encodedSticker.exifMeta?.emojis?.length ? encodedSticker.exifMeta.emojis : ['✨'],
          animatedStickerPack: encodedSticker.animated,
        });

    if (dispatchedJob) {
      return {
        ok: true,
        platform,
        strategy: 'wa-bot-relay',
        stickerType: encodedSticker.stickerType,
        supportsAudioInNativePackApi: false,
        canDirectSendViaGateway: true,
        supported: true,
        headline: 'Figurinha enviada para a fila do WhatsApp',
        explanation:
          'O StickerWave preparou os binários (WebP 512×512 com EXIF 0x5741 e Ogg/Opus) e iniciou a entrega direta via gateway.',
        nextSteps: [
          'Acompanhe o status de entrega em tempo real.',
          'Após receber a figurinha na conversa do WhatsApp, toque nela para favoritar na sua bandeja.',
        ],
        waMeUrl,
        job: dispatchedJob,
        encodedSticker,
        packManifest,
      };
    }

    if (isSound) {
      return {
        ok: true,
        platform,
        strategy: 'wa-bot-relay',
        stickerType: 'SOUND',
        supportsAudioInNativePackApi: false,
        canDirectSendViaGateway: waConnected,
        supported: waConnected,
        headline: waConnected
          ? 'Pronta para enviar ao seu WhatsApp com áudio embutido'
          : 'Mídia sonora validada — envio direto requer bot WhatsApp conectado',
        explanation: waConnected
          ? 'As APIs oficiais de pacote do Android (ENABLE_STICKER_PACK) e iOS (UIPasteboard) aceitam apenas WebP sem áudio. Por isso o StickerWave transmite a figurinha sonora pelo protocolo experimental diretamente para o seu número.'
          : waBotEnabled
            ? 'O bot WhatsApp está habilitado, mas ainda aguarda leitura do QR Code no painel administrativo para transmitir figurinhas sonoras.'
            : 'Os arquivos finais da sua figurinha sonora (WebP com EXIF 0x5741 + Ogg/Opus) já foram gerados e validados. Como o bot WhatsApp público está desligado nesta instância (para não transformar nenhum número pessoal em bot público), conecte uma conta dedicada ou baixe os arquivos gerados.',
        nextSteps: waConnected
          ? [
              'Informe e confirme seu número em "Enviar pelo WhatsApp".',
              'Abra a conversa recebida no WhatsApp e toque na figurinha para favoritar.',
            ]
          : [
              'Use "Enviar pelo WhatsApp" apenas em uma instância com bot dedicado conectado via QR Code.',
              'Você também pode baixar agora o WebP 512×512, o áudio Ogg/Opus ou o Vídeo com som (MP4).',
            ],
        waMeUrl,
        job: null,
        encodedSticker,
        packManifest: null,
      };
    }

    if (platform === 'android') {
      return {
        ok: true,
        platform,
        strategy: 'android-sticker-pack-manifest',
        stickerType: encodedSticker.stickerType,
        supportsAudioInNativePackApi: false,
        canDirectSendViaGateway: waConnected,
        supported: !waConnected ? true : true,
        headline: 'WebP com metadados EXIF 0x5741 pronto para pacote Android',
        explanation:
          'No Android, a API oficial do WhatsApp (com.whatsapp.intent.action.ENABLE_STICKER_PACK + ContentProvider) exige um aplicativo nativo instalado com pelo menos 3 figurinhas (sem suporte a áudio). No navegador web, você pode enviar direto via bot conectado ou baixar o pacote .wastickers / WebP.',
        nextSteps: [
          'Baixe o WebP 512×512 com tag EXIF 0x5741 ou o pacote .wastickers pronto.',
          'Se houver bot conectado nesta instância, envie diretamente para o seu WhatsApp.',
        ],
        waMeUrl,
        job: null,
        encodedSticker,
        packManifest,
      };
    }

    if (platform === 'ios') {
      return {
        ok: true,
        platform,
        strategy: 'ios-sticker-pasteboard-manifest',
        stickerType: encodedSticker.stickerType,
        supportsAudioInNativePackApi: false,
        canDirectSendViaGateway: waConnected,
        supported: true,
        headline: 'WebP e manifesto WhatsApp preparados para iOS',
        explanation:
          'No iOS, o WhatsApp recebe pacotes via UIPasteboard nativo (net.whatsapp.third-party.sticker-pack), recurso inacessível para páginas Safari/PWA sem app nativo wrapper. O manifesto e o WebP já seguem o schema oficial (sem suporte a áudio nativo no Pasteboard).',
        nextSteps: [
          'Se um bot dedicado estiver conectado, envie diretamente para a sua conversa.',
          'Ou baixe o WebP 512×512 / Vídeo com som para compartilhar pelo iOS.',
        ],
        waMeUrl,
        job: null,
        encodedSticker,
        packManifest,
      };
    }

    return {
      ok: true,
      platform,
      strategy: 'browser-download-fallback',
      stickerType: encodedSticker.stickerType,
      supportsAudioInNativePackApi: false,
      canDirectSendViaGateway: waConnected,
      supported: true,
      headline: waConnected
        ? 'Figurinha pronta — envie para o WhatsApp ou baixe os arquivos'
        : 'Figurinha validada (512×512 WebP + EXIF 0x5741)',
      explanation: waConnected
        ? 'Você pode enviar diretamente para um número autorizado no WhatsApp ou baixar o WebP pronto e o pacote .wastickers.'
        : 'O navegador não possui API direta do sistema operacional para injetar pacotes na bandeja do WhatsApp sem bot conectado. Os arquivos otimizados já estão prontos para download ou envio quando um bot dedicado estiver online.',
      nextSteps: [
        'Baixe o WebP 512×512 com metadados EXIF 0x5741 ou o pacote .wastickers.',
        ...(waConnected ? ['Ou clique em Enviar pelo WhatsApp após autorizar seu número.'] : []),
      ],
      waMeUrl,
      job: null,
      encodedSticker,
      packManifest,
    };
  }
}
