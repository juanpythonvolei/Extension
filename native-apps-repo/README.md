# Continuum — Repositório de Compilação dos Apps Nativos

Este repositório compila automaticamente os **aplicativos nativos reais** do **Continuum** para **Linux**, **Windows** e **Android** usando **GitHub Actions** (gratuito para repositórios públicos e privados dentro da cota do GitHub), gerando executáveis prontos para instalar com um clique em **Releases**:

| Plataforma | Artefatos Compilados | Experiência de Instalação |
| --- | --- | --- |
| **Linux (Zorin OS, Ubuntu, Mint, Debian, Pop!_OS)** | `Continuum-Linux-amd64.deb` | Dois cliques na Central de Programas / Zorin Software |
| **Linux Universal (Fedora, Arch, Manjaro, openSUSE)** | `Continuum-Linux-x86_64.AppImage` | Binário portátil — basta executar sem instalar |
| **Windows 10 / 11** | `Continuum-Windows-Setup.exe` + `Continuum-Windows-Portable.exe` | Assistente gráfico nativo com Menu Iniciar e bandeja |
| **Android (Celular e Tablet)** | `Continuum-Android.apk` | Arquivo `.apk` nativo em tela cheia com Wake Lock e captura |

---

## Como gerar os aplicativos prontos (3 passos, sem compilar no seu PC)

1. Crie um repositório novo no GitHub (ex.: `continuum-native`).
2. Envie o conteúdo desta pasta para o branch `main` do repositório:
   ```bash
   git init -b main
   git add .
   git commit -m "Continuum Native Apps v1.2.0"
   git remote add origin https://github.com/SEU_USUARIO/continuum-native.git
   git push -u origin main
   ```
3. Abra a aba **Actions** no GitHub e aguarde ~4 minutos. Ao finalizar, todos os instaladores (`.deb`, `.AppImage`, `.exe` e `.apk`) estarão publicados na aba **Releases** com `SHA256SUMS.txt`.

> **Dica:** Para compilar novamente apontando para outro servidor ou outra malha sem editar código, acesse **Actions → Build Continuum Native Apps → Run workflow** e preencha `server_url` e `room_code`.

## Configuração Padrão Embutida

- **Servidor:** `https://ais-pre-a6iomfzcjhr5udpk6kpqgs-702819737353.us-east1.run.app`
- **Malha inicial:** `MESH01`
- **No app Desktop (Linux/Windows):** você também pode trocar o endereço do servidor ou o código da malha a qualquer momento clicando com o botão direito no ícone da bandeja → **Alterar Servidor / Malha**.

## Conectar as Releases ao painel do Continuum

Após a primeira build no GitHub, abra a aba **Instalar Apps** no Continuum e informe `SEU_USUARIO/continuum-native` na seção **Repositório de Compilação (GitHub Releases)** para exibir os botões de download direto dos binários compilados dentro do próprio app.
