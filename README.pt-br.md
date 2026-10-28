# baileys-wwebjs-failover

**[English](README.md)** | **[Português (Brasil)](README.pt-br.md)**

[![CI](https://img.shields.io/badge/CI-pending-lightgrey.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime](https://img.shields.io/badge/Node.js-20%2B-green.svg)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8%2B-blue.svg)]()

---

## Visão Geral

O `baileys-wwebjs-failover` é um gateway de WhatsApp de alta disponibilidade e otimização de recursos. Ele utiliza o **Baileys** (WebSocket direto via Protobufs) como motor primário para máxima velocidade e consumo mínimo de memória (~50–100 MB de RAM), e executa failover automático para o **whatsapp-web.js** (Puppeteer / Chromium) quando ocorrem erros consecutivos de conexão, evitando a perda total do serviço em atualizações de protocolo do WhatsApp.

## Arquitetura

```mermaid
stateDiagram-v2
    [*] --> PRIMARY_ACTIVE: Inicialização

    state PRIMARY_ACTIVE {
        [*] --> BaileysConnected: Baixo Consumo (~70MB)
        BaileysConnected --> FailureCounter: Erro de Socket / Timeout
        FailureCounter --> BaileysConnected: Sucesso reseta contador
    }

    PRIMARY_ACTIVE --> FENCING: 3-5 Erros Consecutivos

    state FENCING {
        BaileysKill: Encerrar Socket do Baileys
        AcquireLock: Garantir Lock de Consumidor Único
    }

    FENCING --> COLD_START_STANDBY: Baileys Desarmado

    state COLD_START_STANDBY {
        LaunchPuppeteer: Iniciar Chromium (~15-30s)
        WaitReady: Aguardar Evento READY
    }

    COLD_START_STANDBY --> FALLBACK_ACTIVE: WWebJS Pronto

    state FALLBACK_ACTIVE {
        WWebJSRunning: Processamento Inbound & Outbound (~500MB RAM)
        SilentProbe: Probe Silencioso em Background no Baileys
    }

    FALLBACK_ACTIVE --> RECOVERY_SWAP: Baileys Estável no Probe

    state RECOVERY_SWAP {
        DrainWWebJS: Drenar Mensagens Pendentes
        KillChromium: Destruir Browser (Liberar RAM)
        RestoreBaileys: Restaurar Baileys como Ativo
    }

    RECOVERY_SWAP --> PRIMARY_ACTIVE
```

### Principais Capacidades

- **Eficiência de Recursos:** Opera sem navegador Chromium durante 90%+ do tempo, economizando 400–800 MB de RAM por instância.
- **Circuit Breaker & Fencing:** Desconecta e desarma forçadamente o motor falho antes de promover o secundário, eliminando duplicidade de mensagens (split-brain).
- **Keep-Alive Anti-Fingerprint em Standby:** Rotina de manutenção que acorda o WWebJS com variação aleatória de intervalo (3 a 5 dias) e mensagens dinâmicas para evitar a desvinculação da sessão pelo WhatsApp.
- **Desduplicação Atômica:** Filtro atômico no Redis garante processamento *at-most-once* durante janelas de transição entre motores.

## Início Rápido

```bash
# Clonar o repositório
git clone https://github.com/yegear1/baileys-wwebjs-failover.git
cd baileys-wwebjs-failover

# Instalar dependências
pnpm install

# Configurar variáveis de ambiente
cp .env.example .env
```

## Configuração

| Variável | Descrição | Padrão | Obrigatório |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | Modo do ambiente de execução | `development` | Não |
| `PORT` | Porta HTTP para `/health` e `/qr/*` | `3000` | Não |
| `REDIS_URL` | URL de conexão com o Redis | `redis://127.0.0.1:6379` | Sim |
| `AUTH_DIR_BAILEYS` | Diretório de armazenamento das credenciais do Baileys | `/data/auth/baileys` | Não |
| `AUTH_DIR_WWEBJS` | Diretório de armazenamento do perfil do WWebJS | `/data/auth/wwebjs` | Não |
| `FAILOVER_ERROR_THRESHOLD` | Quantidade de erros consecutivos antes do failover | `3` | Não |
| `PROBE_STABILITY_WINDOW_SEC` | Segundos de estabilidade exigidos do Baileys para failback | `300` | Não |
| `KEEPALIVE_INTERVAL_DAYS_MIN` | Intervalo mínimo (em dias) entre pings de manutenção | `3` | Não |
| `KEEPALIVE_INTERVAL_DAYS_MAX` | Intervalo máximo (em dias) entre pings de manutenção | `5` | Não |

## Desenvolvimento

```bash
pnpm install          # Instalar dependências
pnpm test             # Executar suite de testes
pnpm lint             # Executar verificações de linter e formatação
pnpm typecheck        # Checagem estrita de tipos TypeScript
pnpm build            # Compilar projeto para produção
```

## Licença

Distribuído sob a licença [MIT](LICENSE).
