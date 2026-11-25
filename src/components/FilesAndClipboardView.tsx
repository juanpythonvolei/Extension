import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Clipboard,
  ClipboardPaste,
  Copy,
  Download,
  File as FileIcon,
  Send,
  Trash2,
  Upload,
} from 'lucide-react';
import type { ClipboardItem, DeviceNode, FileTransferRecord } from '../types/mesh';
import { formatBytes, formatOsLabel } from '../utils/deviceDetector';

interface FilesAndClipboardViewProps {
  peerDevices: DeviceNode[];
  preferredTargetId: string | null;
  transfers: FileTransferRecord[];
  clipboard: ClipboardItem[];
  onSendFile: (file: File, toDeviceId: string | 'all') => Promise<void>;
  onClearTransfers: () => void;
  onPushClipboard: (content: string) => void;
  onDeleteClipboard: (id: string) => void;
}

export const FilesAndClipboardView: React.FC<FilesAndClipboardViewProps> = ({
  peerDevices,
  preferredTargetId,
  transfers,
  clipboard,
  onSendFile,
  onClearTransfers,
  onPushClipboard,
  onDeleteClipboard,
}) => {
  const [targetId, setTargetId] = useState<string | 'all'>(preferredTargetId || 'all');
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [clipInput, setClipInput] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (preferredTargetId && peerDevices.some((p) => p.id === preferredTargetId)) {
      setTargetId(preferredTargetId);
    }
  }, [peerDevices, preferredTargetId]);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    for (const file of Array.from(fileList)) {
      await onSendFile(file, targetId);
    }
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingOver(false);
    await handleFiles(e.dataTransfer.files);
  };

  const handlePushSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!clipInput.trim()) return;
    onPushClipboard(clipInput);
    setClipInput('');
  };

  const handleReadSystemClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        onPushClipboard(text);
      }
    } catch {
      // Browser denied clipboard read permission
    }
  };

  const handleCopyItem = async (item: ClipboardItem) => {
    try {
      await navigator.clipboard.writeText(item.content);
      setCopiedId(item.id);
      window.setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // ignore
    }
  };

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.15fr_0.85fr]">
      {/* Real-Time File Transfer Column */}
      <section className="flex flex-col rounded-lg border border-[#222936] bg-[#11151B]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#222936] px-5 py-3.5">
          <div>
            <h1 className="text-base font-semibold text-[#F1F5F9]">Transferência de Arquivos em Tempo Real</h1>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Arraste documentos, imagens ou pacotes para enviar instantaneamente entre os aparelhos pareados.
            </p>
          </div>
          <select
            aria-label="Destino da transferência"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="h-9 rounded-md border border-[#222936] bg-[#090B0E] px-3 text-xs text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
          >
            <option value="all">Todos os dispositivos ({peerDevices.length})</option>
            {peerDevices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({formatOsLabel(d.os)})
              </option>
            ))}
          </select>
        </div>

        <div className="p-5">
          {/* Dropzone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingOver(true);
            }}
            onDragLeave={() => setIsDraggingOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
            }}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-6 py-9 text-center transition-colors ${
              isDraggingOver
                ? 'border-[#3B82F6] bg-[#3B82F6]/10'
                : 'border-[#2E3748] bg-[#090B0E] hover:border-[#3B82F6]'
            }`}
          >
            <Upload className="h-6 w-6 text-[#60A5FA]" />
            <p className="mt-3 text-sm font-medium text-[#F1F5F9]">
              Solte arquivos aqui ou clique para selecionar
            </p>
            <p className="mt-1 text-xs text-[#94A3B8]">
              Envio contínuo em blocos binários com reconstrução imediata no dispositivo de destino.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                handleFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          {/* Transfers List */}
          <div className="mt-5">
            <div className="flex items-center justify-between border-b border-[#222936] pb-2.5 text-xs text-[#94A3B8]">
              <span className="font-medium">Histórico de Transferências</span>
              <div className="flex items-center gap-3">
                <span className="font-mono tabular-nums">{transfers.length} itens</span>
                {transfers.some((t) => t.status !== 'transferring') && (
                  <button
                    type="button"
                    onClick={onClearTransfers}
                    className="inline-flex items-center gap-1 text-[11px] text-[#94A3B8] transition-colors hover:text-[#DC2626]"
                  >
                    <Trash2 className="h-3 w-3" />
                    Limpar
                  </button>
                )}
              </div>
            </div>

            {transfers.length === 0 ? (
              <div className="py-10 text-center text-xs text-[#64748B]">
                Nenhum arquivo transferido nesta sessão. Arraste um arquivo acima para iniciar.
              </div>
            ) : (
              <div className="divide-y divide-[#222936]">
                {transfers.map((tr) => (
                  <div key={tr.id} className="flex flex-col gap-2 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <FileIcon className="mt-0.5 h-4 w-4 shrink-0 text-[#94A3B8]" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-[#F1F5F9]">{tr.fileName}</p>
                        <p className="mt-0.5 text-xs text-[#94A3B8]">
                          <span className="font-mono tabular-nums">{formatBytes(tr.fileSize)}</span>
                          {' · '}
                          {tr.fromDeviceName} → {tr.toDeviceName}
                          {' · '}
                          <span className="font-mono tabular-nums">{formatTime(tr.createdAt)}</span>
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      {tr.status === 'transferring' ? (
                        <div className="w-36">
                          <div className="flex justify-between font-mono text-[11px] text-[#94A3B8] tabular-nums">
                            <span>{tr.progress}%</span>
                            <span>{tr.speedMbps} MB/s</span>
                          </div>
                          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#171C24]">
                            <div
                              className="h-full bg-[#3B82F6] transition-all"
                              style={{ width: `${tr.progress}%` }}
                            />
                          </div>
                        </div>
                      ) : tr.status === 'failed' ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#DC2626]">
                          <AlertCircle className="h-3.5 w-3.5" />
                          Falhou
                        </span>
                      ) : tr.downloadUrl ? (
                        <a
                          href={tr.downloadUrl}
                          download={tr.fileName}
                          className="inline-flex items-center gap-1.5 rounded-md border border-[#222936] bg-[#171C24] px-3 py-1.5 text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6] whitespace-nowrap"
                        >
                          <Download className="h-3.5 w-3.5 text-[#60A5FA]" />
                          Baixar
                        </a>
                      ) : (
                        <span className="text-xs font-medium text-[#16A34A]">Concluído</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Universal Clipboard Column */}
      <section className="flex flex-col rounded-lg border border-[#222936] bg-[#11151B]">
        <div className="flex items-center justify-between gap-3 border-b border-[#222936] px-5 py-3.5">
          <div>
            <h2 className="text-base font-semibold text-[#F1F5F9]">Área de Transferência Universal</h2>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Copie em um aparelho e cole instantaneamente em qualquer outro.
            </p>
          </div>
          <button
            type="button"
            onClick={handleReadSystemClipboard}
            className="inline-flex items-center gap-1.5 rounded-md border border-[#222936] bg-[#171C24] px-3 py-1.5 text-xs font-medium text-[#CBD5E1] transition-colors hover:border-[#3B82F6] hover:text-[#F1F5F9] whitespace-nowrap shrink-0"
          >
            <ClipboardPaste className="h-3.5 w-3.5 text-[#60A5FA]" />
            Capturar
          </button>
        </div>

        <div className="flex flex-1 flex-col p-5">
          <form onSubmit={handlePushSubmit} className="space-y-2.5">
            <textarea
              rows={3}
              value={clipInput}
              onChange={(e) => setClipInput(e.target.value)}
              placeholder="Cole um texto, link ou trecho de código aqui para sincronizar com toda a malha..."
              className="w-full resize-none rounded-md border border-[#222936] bg-[#090B0E] p-3 text-sm text-[#F1F5F9] placeholder-[#64748B] focus:border-[#3B82F6] focus:outline-none"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={!clipInput.trim()}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#3B82F6] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] disabled:opacity-40"
              >
                <Send className="h-3.5 w-3.5" />
                Sincronizar texto
              </button>
            </div>
          </form>

          <div className="mt-5 flex-1">
            <div className="flex items-center justify-between border-b border-[#222936] pb-2.5 text-xs text-[#94A3B8]">
              <span className="font-medium">Itens Sincronizados</span>
              <span className="font-mono tabular-nums">{clipboard.length}</span>
            </div>

            {clipboard.length === 0 ? (
              <div className="flex flex-col items-center py-10 text-center text-xs text-[#64748B]">
                <Clipboard className="h-7 w-7 text-[#2E3748]" />
                <p className="mt-2.5">Nenhum texto compartilhado ainda.</p>
              </div>
            ) : (
              <div className="divide-y divide-[#222936]">
                {clipboard.map((item) => (
                  <div key={item.id} className="py-3.5">
                    <div className="flex items-center justify-between gap-2 text-[11px] text-[#94A3B8]">
                      <span>
                        {item.sourceDeviceName} · {item.kind === 'url' ? 'Link' : item.kind === 'code' ? 'Código' : 'Texto'} ·{' '}
                        <span className="font-mono tabular-nums">{formatTime(item.createdAt)}</span>
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleCopyItem(item)}
                          className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-[#CBD5E1] hover:bg-[#171C24] hover:text-[#F1F5F9]"
                        >
                          {copiedId === item.id ? (
                            <>
                              <Check className="h-3.5 w-3.5 text-[#16A34A]" />
                              Copiado
                            </>
                          ) : (
                            <>
                              <Copy className="h-3.5 w-3.5" />
                              Copiar
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteClipboard(item.id)}
                          className="rounded-sm p-1 text-[#64748B] hover:bg-[#171C24] hover:text-[#DC2626]"
                          aria-label="Remover item"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    <pre
                      className={`mt-1.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed ${
                        item.kind === 'code' ? 'font-mono text-[#CBD5E1]' : 'font-sans text-[#F1F5F9]'
                      }`}
                    >
                      {item.content}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
