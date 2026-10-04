export interface AgentMeta {
  id: string; // e.g., 'phantom'
  key: string; // strategy key e.g., 'ict_smc'
  codename: string; // 'PHANTOM'
  strategyName: string; // 'ICT/SMC'
  fullName: string; // 'PHANTOM (ICT/SMC)'
  image: string; // '/images/agents/phantom.png'
  description?: string;
}

export const AGENT_CONFIGS: Record<string, AgentMeta> = {
  ict_smc: {
    id: 'phantom',
    key: 'ict_smc',
    codename: 'PHANTOM',
    strategyName: 'ICT/SMC',
    fullName: 'PHANTOM (ICT/SMC)',
    image: '/images/agents/phantom.png',
  },
  breakout_retest: {
    id: 'breach',
    key: 'breakout_retest',
    codename: 'BREACH',
    strategyName: 'Breakout-Retest',
    fullName: 'BREACH (Breakout-Retest)',
    image: '/images/agents/breach.png',
  },
  trend_following: {
    id: 'vanguard',
    key: 'trend_following',
    codename: 'VANGUARD',
    strategyName: 'Trend Following',
    fullName: 'VANGUARD (Trend Following)',
    image: '/images/agents/vanguard.png',
  },
  wyckoff: {
    id: 'oracle',
    key: 'wyckoff',
    codename: 'ORACLE',
    strategyName: 'Wyckoff',
    fullName: 'ORACLE (Wyckoff)',
    image: '/images/agents/oracle.png',
  },
  mean_reversion: {
    id: 'eclipse',
    key: 'mean_reversion',
    codename: 'ECLIPSE',
    strategyName: 'Mean Reversion',
    fullName: 'ECLIPSE (Mean Reversion)',
    image: '/images/agents/eclipse.png',
  },
  vwap: {
    id: 'pulse',
    key: 'vwap',
    codename: 'PULSE',
    strategyName: 'VWAP',
    fullName: 'PULSE (VWAP)',
    image: '/images/agents/pulse.png',
  },
  opening_range: {
    id: 'sentinel',
    key: 'opening_range',
    codename: 'SENTINEL',
    strategyName: 'Opening Range',
    fullName: 'SENTINEL (Opening Range)',
    image: '/images/agents/sentinel.png',
  },
  momentum: {
    id: 'volt',
    key: 'momentum',
    codename: 'VOLT',
    strategyName: 'Momentum',
    fullName: 'VOLT (Momentum)',
    image: '/images/agents/volt.png',
  },
  order_flow: {
    id: 'spectre',
    key: 'order_flow',
    codename: 'SPECTRE',
    strategyName: 'Order Flow',
    fullName: 'SPECTRE (Order Flow)',
    image: '/images/agents/spectre.png',
  },
  statistical_pairs: {
    id: 'nexus',
    key: 'statistical_pairs',
    codename: 'NEXUS',
    strategyName: 'Statistical Pairs',
    fullName: 'NEXUS (Statistical Pairs)',
    image: '/images/agents/nexus.png',
  },
};

/**
 * Helper to retrieve agent metadata by either strategy key, id/codename, or raw name.
 */
export function getAgentMeta(keyOrName?: string): AgentMeta {
  if (!keyOrName) {
    return {
      id: 'unknown',
      key: 'unknown',
      codename: 'AI AGENT',
      strategyName: 'Quantitative',
      fullName: 'AI AGENT (Quantitative)',
      image: '/images/agents/phantom.png',
    };
  }

  const normalized = keyOrName.toLowerCase().trim();

  // 1. Direct match on strategy key
  if (AGENT_CONFIGS[normalized]) return AGENT_CONFIGS[normalized];

  // 2. Match by id or codename
  for (const item of Object.values(AGENT_CONFIGS)) {
    if (
      item.id === normalized ||
      item.codename.toLowerCase() === normalized ||
      normalized.includes(item.id) ||
      normalized.includes(item.codename.toLowerCase())
    ) {
      return item;
    }
  }

  // 3. Fallback matching against strategy keywords
  if (normalized.includes('ict') || normalized.includes('smart money')) return AGENT_CONFIGS.ict_smc;
  if (normalized.includes('breakout') || normalized.includes('retest')) return AGENT_CONFIGS.breakout_retest;
  if (normalized.includes('trend')) return AGENT_CONFIGS.trend_following;
  if (normalized.includes('wyckoff')) return AGENT_CONFIGS.wyckoff;
  if (normalized.includes('reversion') || normalized.includes('bollinger')) return AGENT_CONFIGS.mean_reversion;
  if (normalized.includes('vwap')) return AGENT_CONFIGS.vwap;
  if (normalized.includes('opening')) return AGENT_CONFIGS.opening_range;
  if (normalized.includes('momentum')) return AGENT_CONFIGS.momentum;
  if (normalized.includes('order flow') || normalized.includes('delta')) return AGENT_CONFIGS.order_flow;
  if (normalized.includes('pairs') || normalized.includes('statistical')) return AGENT_CONFIGS.statistical_pairs;

  return {
    id: 'agent',
    key: keyOrName,
    codename: keyOrName.toUpperCase(),
    strategyName: 'Strategy Unit',
    fullName: `${keyOrName.toUpperCase()} (Strategy Unit)`,
    image: '/images/agents/phantom.png',
  };
}
