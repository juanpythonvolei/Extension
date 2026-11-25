import React, { useState } from 'react';
import { Download, Share, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="inline-flex items-center gap-2 rounded-md border border-[#2E3748] bg-[#171C24] px-3.5 py-2 text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6] hover:bg-[#1E2532] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B82F6] whitespace-nowrap shrink-0"
      >
        <Download className="h-3.5 w-3.5 text-[#60A5FA]" aria-hidden="true" />
        Instalar App
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex items-center gap-2 rounded-md border border-[#2E3748] bg-[#171C24] px-3.5 py-2 text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6] whitespace-nowrap shrink-0"
        >
          <Share className="h-3.5 w-3.5 text-[#60A5FA]" aria-hidden="true" />
          Instalar no iOS
        </button>

        {showIOSGuide && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ios-install-title"
          >
            <div className="w-full max-w-sm rounded-lg border border-[#222936] bg-[#11151B] p-6">
              <div className="flex items-center justify-between">
                <h3 id="ios-install-title" className="text-base font-semibold text-[#F1F5F9]">
                  Instalar no iPhone ou iPad
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  className="rounded-md p-1.5 text-[#94A3B8] hover:bg-[#171C24] hover:text-[#F1F5F9]"
                  aria-label="Fechar guia"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <ol className="mt-4 space-y-2.5 text-sm leading-relaxed text-[#CBD5E1]">
                <li>1. Toque no botão Compartilhar na barra do Safari.</li>
                <li>2. Role o menu e toque em Adicionar à Tela de Início.</li>
                <li>3. Confirme em Adicionar para usar o Continuum em tela cheia.</li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-6 w-full rounded-md bg-[#3B82F6] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#2563EB]"
              >
                Entendi
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-16 left-4 z-50 flex items-center gap-2 rounded-md border border-[#D97706]/50 bg-[#171C24] px-3.5 py-2 text-xs font-medium text-[#FBBF24] lg:bottom-4"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>Modo offline — aguardando reconexão com a malha.</span>
    </div>
  );
};
