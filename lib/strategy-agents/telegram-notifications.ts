import { getAgentMeta } from './agent-config';
import { prisma } from '@/lib/db/prisma';

/** Bot numbers map strategy agents that have Telegram notification tokens. */
const AGENT_BOT_NUMBER: Record<string, number> = {
  ict_smc: 1,
  breakout_retest: 2,
  trend_following: 3,
  wyckoff: 4,
  mean_reversion: 5,
  vwap: 6,
  opening_range: 7,
  momentum: 8,
  order_flow: 9,
};

export type StrategyTradeNotification = {
  event: 'ENTRY' | 'EXIT';
  agentKey: string;
  marketType: string;
  currency: string;
  symbol: string;
  direction: string;
  contractSide?: string;
  quantity: number;
  entryPrice: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  exitPrice?: number;
  realizedPnL?: number;
  confidence?: number;
  reason: string;
  timestamp: Date;
};

export type StrategyScanNotification = {
  event: 'SCAN';
  agentKey: string;
  marketType: string;
  currency: string;
  status: 'NO_TRADE' | 'MANAGING_POSITION' | 'RISK_LOCK' | 'WAITING_FOR_ENTRY_WINDOW' | 'WAITING_FOR_MARKET' | 'WAITING_FOR_LIVE_DATA';
  reason: string;
  analyses: Array<{
    symbol: string;
    price: number;
    signal: string;
    confidence: number;
    checksMet: number;
    checksTotal: number;
    waitingFor: string[];
  }>;
  position?: {
    symbol: string;
    side: string;
    quantity: number;
    entryPrice: number;
    currentPrice: number;
    stopLossPrice: number;
    takeProfitPrice: number;
    unrealizedPnL?: number;
  };
  forceUpdate?: boolean;
  timestamp: Date;
};

const STATUS_EDIT_INTERVAL_MS = 60_000;

function getTelegramChatIds() {
  const multipleIds = process.env.TRADEX_TELEGRAM_CHAT_IDS
    ?.split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  const ids = multipleIds?.length ? multipleIds : [process.env.TRADEX_TELEGRAM_CHAT_ID || ''];
  return [...new Set(ids.filter(Boolean))];
}

async function sendTelegramMessage(token: string, chatIds: string[], text: string, label: string) {
  const formattedText = telegramJsonBlock(text);
  await Promise.all(chatIds.map(async (chatId) => {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: formattedText, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(8_000),
        cache: 'no-store',
      });
      const result = await response.json().catch(() => null) as { ok?: boolean } | null;
      if (!response.ok || !result?.ok) console.error(`[strategy-telegram] Delivery failed for ${label}; HTTP ${response.status}.`);
    } catch {
      console.error(`[strategy-telegram] Delivery unavailable for ${label}.`);
    }
  }));
}

function telegramJsonBlock(text: string) {
  return `<pre><code class="language-json">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`;
}

async function editOrCreateStatusMessage(token: string, chatId: string, botNumber: number, event: StrategyScanNotification, jsonText: string, label: string) {
  const key = { botNumber, marketType: event.marketType, chatId };
  const where = { botNumber_marketType_chatId: key };
  const existing = await prisma.strategyTelegramStatus.findUnique({ where });
  const statusChanged = existing?.statusCode !== event.status;
  const timeToRefresh = !existing || Date.now() - existing.lastEditedAt.getTime() >= STATUS_EDIT_INTERVAL_MS;
  if (existing && !event.forceUpdate && !statusChanged && !timeToRefresh) return;

  const makeRequest = async (editMessageId?: number) => {
    const isEdit = editMessageId !== undefined;
    const response = await fetch(`https://api.telegram.org/bot${token}/${isEdit ? 'editMessageText' : 'sendMessage'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        ...(isEdit ? { message_id: editMessageId } : {}),
        text: telegramJsonBlock(jsonText),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    });
    const result = await response.json().catch(() => null) as { ok?: boolean; description?: string; result?: { message_id?: number } } | null;
    return { response, result };
  };

  try {
    let sent: Awaited<ReturnType<typeof makeRequest>>;
    if (existing) {
      sent = await makeRequest(existing.messageId);
      if (!sent.result?.ok && /message to edit not found|message can't be edited/i.test(sent.result?.description || '')) {
        sent = await makeRequest();
      }
    } else {
      sent = await makeRequest();
    }

    if (!sent.response.ok || !sent.result?.ok) {
      if (/message is not modified/i.test(sent.result?.description || '') && existing) {
        await prisma.strategyTelegramStatus.update({ where, data: { statusCode: event.status, lastEditedAt: event.timestamp } });
        return;
      }
      console.error(`[strategy-telegram] Status update failed for ${label}; HTTP ${sent.response.status}.`);
      return;
    }

    const messageId = sent.result.result?.message_id ?? existing?.messageId;
    if (messageId === undefined) {
      console.error(`[strategy-telegram] Status update returned no message ID for ${label}.`);
      return;
    }
    await prisma.strategyTelegramStatus.upsert({
      where,
      create: { ...key, messageId, statusCode: event.status, messageText: jsonText, lastEditedAt: event.timestamp },
      update: { messageId, statusCode: event.status, messageText: jsonText, lastEditedAt: event.timestamp },
    });
  } catch {
    console.error(`[strategy-telegram] Status update unavailable for ${label}.`);
  }
}

/** Sends one readiness message per configured bot at application startup. */
export async function sendStrategyBotOnlineNotifications() {
  const chatIds = getTelegramChatIds();
  if (!chatIds.length) return;

  await Promise.all(Object.entries(AGENT_BOT_NUMBER).map(async ([agentKey, botNumber]) => {
    const token = process.env[`TRADEX_TELEGRAM_AGENT_${botNumber}_TOKEN`];
    if (!token) return;
    const agent = getAgentMeta(agentKey);
    await sendTelegramMessage(token, chatIds, JSON.stringify({
      event: 'BOT_ONLINE',
      agent: { key: agentKey, name: agent.fullName },
      status: 'ready',
      timestamp_ist: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST',
    }, null, 2), `agent ${botNumber} startup`);
  }));
}

function money(value: number, currency: string) {
  const amount = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'USDT' ? `$${amount} USDT` : `₹${amount} INR`;
}

function clipped(value: string, maxLength = 500) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function formatMessage(event: StrategyTradeNotification | StrategyScanNotification) {
  const agent = getAgentMeta(event.agentKey);
  const timestamp = event.timestamp.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
  if (event.event === 'SCAN') {
    return JSON.stringify({
      event: 'STRATEGY_CHECK_IN',
      agent: { key: event.agentKey, name: agent.fullName },
      market_type: event.marketType,
      status: event.status,
      reason: clipped(event.reason),
      analysis: {
        timeframe: '5m completed candle',
        symbols: event.analyses.map((analysis) => ({
          symbol: analysis.symbol,
          mark_price: analysis.price,
          currency: event.currency,
          signal: analysis.signal,
          rule_score_percent: Number((analysis.confidence * 100).toFixed(1)),
          is_win_probability: false,
          checks_met: analysis.checksMet,
          checks_total: analysis.checksTotal,
          waiting_for: analysis.waitingFor.slice(0, 2).map((check) => clipped(check, 160)),
        })),
      },
      position: event.position ? {
        symbol: event.position.symbol,
        side: event.position.side,
        quantity: event.position.quantity,
        entry_price: event.position.entryPrice,
        current_mark: event.position.currentPrice,
        stop_loss: event.position.stopLossPrice,
        take_profit: event.position.takeProfitPrice,
        estimated_net_unrealized_pnl: event.position.unrealizedPnL ?? null,
        currency: event.currency,
      } : null,
      paper_trading: true,
      timestamp_ist: timestamp,
    }, null, 2);
  }
  if (event.event === 'ENTRY') {
    const risk = event.stopLossPrice === undefined ? undefined : Math.abs(event.entryPrice - event.stopLossPrice) * event.quantity;
    const reward = event.takeProfitPrice === undefined ? undefined : Math.abs(event.takeProfitPrice - event.entryPrice) * event.quantity;
    const riskReward = risk && reward ? (reward / risk).toFixed(2) : null;
    return JSON.stringify({
      event: 'TRADE_CALL_TAKEN',
      agent: { key: event.agentKey, name: agent.fullName },
      execution: 'PAPER_SIMULATION_ONLY',
      market_type: event.marketType,
      symbol: event.symbol,
      side: event.direction,
      contract_side: event.contractSide ?? null,
      quantity: event.quantity,
      entry_price: event.entryPrice,
      stop_loss: event.stopLossPrice ?? null,
      take_profit: event.takeProfitPrice ?? null,
      planned_risk_reward: riskReward ? `1:${riskReward}` : null,
      estimated_gross_risk: risk ?? null,
      estimated_gross_reward: reward ?? null,
      currency: event.currency,
      rule_score_percent: event.confidence === undefined ? null : Number((event.confidence * 100).toFixed(1)),
      is_win_probability: false,
      explanation: clipped(event.reason),
      timestamp_ist: timestamp,
    }, null, 2);
  }

  const pnl = event.realizedPnL ?? 0;
  return JSON.stringify({
    event: 'TRADE_CLOSED',
    agent: { key: event.agentKey, name: agent.fullName },
    market_type: event.marketType,
    symbol: event.symbol,
    side: event.direction,
    contract_side: event.contractSide ?? null,
    quantity: event.quantity,
    entry_price: event.entryPrice,
    exit_price: event.exitPrice ?? null,
    realized_pnl_net: pnl,
    currency: event.currency,
    result: clipped(event.reason),
    timestamp_ist: timestamp,
  }, null, 2);
}

/** Delivers only after the database transaction commits; delivery errors never undo a paper trade. */
export async function sendStrategyTradeNotifications(events: StrategyTradeNotification[]) {
  const chatIds = getTelegramChatIds();
  if (!chatIds.length || !events.length) return;

  await Promise.all(events.map(async (event) => {
    const botNumber = AGENT_BOT_NUMBER[event.agentKey];
    const token = botNumber ? process.env[`TRADEX_TELEGRAM_AGENT_${botNumber}_TOKEN`] : undefined;
    if (!token) return;

    const agent = getAgentMeta(event.agentKey);
    await sendTelegramMessage(token, chatIds, formatMessage(event), `${agent.fullName} (${event.event})`);
  }));
}

/** Maintains one editable status message per bot, market mode, and Telegram chat. */
export async function sendStrategyScanNotifications(events: StrategyScanNotification[]) {
  const chatIds = getTelegramChatIds();
  if (!chatIds.length || !events.length) return;

  await Promise.all(events.map(async (event) => {
    const botNumber = AGENT_BOT_NUMBER[event.agentKey];
    const token = botNumber ? process.env[`TRADEX_TELEGRAM_AGENT_${botNumber}_TOKEN`] : undefined;
    if (!token) return;
    const agent = getAgentMeta(event.agentKey);
    const message = formatMessage(event);
    await Promise.all(chatIds.map((chatId) => editOrCreateStatusMessage(token, chatId, botNumber!, event, message, `${agent.fullName} status`)));
  }));
}
