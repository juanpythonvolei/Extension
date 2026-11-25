import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, ExternalLink, RefreshCw, Smartphone, X } from 'lucide-react';
import { generateRoomCode } from '../utils/deviceDetector';

interface PairingModalProps {
  open: boolean;
  roomCode: string;
  deviceCount: number;
  onClose: () => void;
  onSwitchRoom: (code: string) => void;
}

export const PairingModal: React.FC<PairingModalProps> = ({
  open,
  roomCode,
  deviceCount,
  onClose,
  onSwitchRoom,
}) => {
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [joinInput, setJoinInput] = useState('');
  const [copiedField, setCopiedField] = useState<'code' | 'link' | null>(null);

  const shareUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomCode)}`;

  useEffect(() => {
    if (!open) return;
    let active = true;
    QRCode.toDataURL(shareUrl, {
      width: 220,
      margin: 2,
      color: {
        dark: '#F1F5F9',
        light: '#11151B',
      },
    })
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch(() => {
        if (active) setQrDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [open, shareUrl]);

  if (!open) return null;

  const copyText = async (text: string, field: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      window.setTimeout(() => setCopiedField(null), 1800);
    } catch {
      // Clipboard API fallback ignored
    }
  };

  const handleJoinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = joinInput.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleaned.length >= 4) {
      onSwitchRoom(cleaned);
      setJoinInput('');
      onClose();
    }
  };

  const handleGenerateNew = () => {
    const fresh = generateRoomCode();
    onSwitchRoom(fresh);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pairing-modal-title"
    >
      <div className="w-full max-w-xl rounded-lg border border-[#222936] bg-[#11151B] p-6">
        <div className="flex items-start justify-between gap-4 border-b border-[#222936] pb-4">
          <div>
            <h2 id="pairing-modal-title" className="text-lg font-semibold text-[#F1F5F9]">
              Parear Novo Dispositivo
            </h2>
            <p className="mt-1 text-xs text-[#94A3B8]">
              Windows · Linux · Android · iOS — {deviceCount}{' '}
              {deviceCount === 1 ? 'dispositivo ativo nesta malha' : 'dispositivos ativos nesta malha'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-2 text-[#94A3B8] transition-colors hover:bg-[#171C24] hover:text-[#F1F5F9]"
            aria-label="Fechar janela de pareamento"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-6 sm:grid-cols-[200px_1fr]">
          <div className="flex flex-col items-center justify-center rounded-md border border-[#222936] bg-[#090B0E] p-3">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt={`QR Code da malha ${roomCode}`}
                className="h-44 w-44 rounded-sm"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex h-44 w-44 items-center justify-center text-xs text-[#64748B]">
                Gerando QR Code...
              </div>
            )}
            <p className="mt-2.5 text-center text-[11px] text-[#94A3B8]">
              Aponte a câmera do celular ou tablet
            </p>
          </div>

          <div className="flex flex-col justify-between gap-4">
            <div>
              <label className="block text-xs font-medium text-[#94A3B8]">Código da Malha Atual</label>
              <div className="mt-2 flex items-center gap-2">
                <div className="flex-1 rounded-md border border-[#222936] bg-[#090B0E] px-3.5 py-2.5 font-mono text-xl font-semibold tracking-[0.22em] text-[#F1F5F9] tabular-nums">
                  {roomCode}
                </div>
                <button
                  type="button"
                  onClick={() => copyText(roomCode, 'code')}
                  className="inline-flex h-11 items-center gap-1.5 rounded-md border border-[#222936] bg-[#171C24] px-3 text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6] whitespace-nowrap shrink-0"
                >
                  {copiedField === 'code' ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-[#16A34A]" />
                      Copiado
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5 text-[#94A3B8]" />
                      Copiar
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleGenerateNew}
                  title="Gerar novo código de malha"
                  className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-[#222936] bg-[#171C24] text-[#94A3B8] transition-colors hover:border-[#3B82F6] hover:text-[#F1F5F9] shrink-0"
                  aria-label="Gerar novo código de malha"
                >
                  <RefreshCw className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => copyText(shareUrl, 'link')}
                className="inline-flex items-center gap-2 rounded-md border border-[#222936] bg-[#171C24] px-3.5 py-2 text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6] whitespace-nowrap"
              >
                {copiedField === 'link' ? (
                  <Check className="h-3.5 w-3.5 text-[#16A34A]" />
                ) : (
                  <Smartphone className="h-3.5 w-3.5 text-[#60A5FA]" />
                )}
                {copiedField === 'link' ? 'Link copiado' : 'Copiar link direto'}
              </button>

              <a
                href={shareUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-md bg-[#3B82F6] px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] whitespace-nowrap"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Abrir 2ª Tela nesta máquina
              </a>
            </div>

            <form onSubmit={handleJoinSubmit} className="border-t border-[#222936] pt-4">
              <label htmlFor="join-mesh-input" className="block text-xs font-medium text-[#94A3B8]">
                Ou conectar a uma malha existente
              </label>
              <div className="mt-2 flex items-center gap-2">
                <input
                  id="join-mesh-input"
                  type="text"
                  value={joinInput}
                  onChange={(e) => setJoinInput(e.target.value.toUpperCase())}
                  placeholder="Digite o PIN (ex: A7K9P2)"
                  maxLength={8}
                  className="h-10 flex-1 rounded-md border border-[#222936] bg-[#090B0E] px-3 font-mono text-sm uppercase tracking-widest text-[#F1F5F9] placeholder-[#64748B] focus:border-[#3B82F6] focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={joinInput.trim().length < 4}
                  className="h-10 rounded-md border border-[#2E3748] bg-[#171C24] px-4 text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6] disabled:cursor-not-allowed disabled:opacity-40 whitespace-nowrap shrink-0"
                >
                  Entrar
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};
