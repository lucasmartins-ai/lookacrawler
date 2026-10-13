/**
 * Deterministic purchase-intent pre-filter for social posts and comments
 * (pt-BR + EN). Cheap first pass before any LLM judgment: separate a buyer
 * ("procuro ... / looking for ...") and a price/availability question from
 * seller ads. Rules are anchored on whole words over accent-free lowercase text.
 *
 * `generic` is the default lexicon; `car` is a built-in vertical that also
 * requires vehicle context and ignores parts/services shopping.
 */

export type IntentKind = "buyer" | "price_question" | "seller" | "none";

export interface PurchaseIntent {
  kind: IntentKind;
  isLead: boolean;
  score: number; // 0-100
  matched: string[];
  region: string | null;
  budget: number | null;
}

export interface IntentLexicon {
  buyer: RegExp[];
  question: RegExp[];
  seller: RegExp[];
  /** When set, a buyer match only counts if the text also matches this. */
  context?: RegExp;
  /** A buyer match is dropped when this matches (jobs, parts, services...). */
  exclude?: RegExp;
}

const GENERIC: IntentLexicon = {
  buyer: [
    /\b(procuro|procurando|to buscando|estou buscando|estou procurando)\b/,
    /\b(quero|gostaria de|pretendo) (comprar|contratar|adquirir)\b/,
    /\bpreciso (de|contratar|comprar)\b/,
    /\balguem (vende|vendendo|indica|recomenda|conhece|faz)\b/,
    /\b(interesse em|orcamento para) (comprar|contratar)\b|\bcompro\b/,
    /\b(looking for|looking to (buy|hire)|in the market for|want to (buy|hire)|need (a|an|to buy|to hire))\b/,
    /\b(anyone|can anyone|can somebody) (recommend|know|selling|sell)\b|\brecommendations? for\b/,
    /\bwhere (can|do) i (buy|find|get)\b/,
  ],
  question: [
    /^\s*(valor|preco|quanto|price)\b/,
    /\b(qual o (valor|preco)|quanto (custa|sai|ta|esta)|manda o valor|passa o valor|me passa (o )?orcamento)\b/,
    /\b(how much|what('?s| is| does) .{0,20}(cost|price)|price\?)\b/,
    /\b(ainda )?(ta |esta )?disponivel\b|\bstill available\b/,
    /\b(tenho|have) interesse\b|\bi'?m interested\b/,
    /\b(me chama|chama no (privado|pv|zap|whats|direct|dm))\b|\b(dm me|message me|pm me)\b/,
  ],
  seller: [
    /\b(vendo|vende-se|vende se|a venda|for sale|selling)\b/,
    /\b(promocao|aproveite|desconto|oferta imperdivel|limited time|% off)\b/,
    /\b(nossos? (servicos|produtos)|trabalhamos com|we (offer|sell|provide)|book now|entre em contato)\b/,
  ],
  exclude: /\b(emprego|vagas?|estagio|curriculo|jobs?|hiring|resume|internship)\b/,
};

const CAR: IntentLexicon = {
  buyer: [
    /\b(procuro|procurando|to buscando|estou buscando)\b/,
    /\bquero (comprar|um carro|uma moto|um veiculo)\b/,
    /\bpreciso de um (carro|veiculo)\b/,
    /\balguem (vende|vendendo|tem .{0,30}pra vender|indica)\b/,
    /\bcompro\b/,
    /\binteresse em comprar\b/,
    /\bqual carro (comprar|compensa)\b/,
  ],
  question: [
    /^\s*(valor|preco|quanto)\b/,
    /\b(qual o valor|quanto (ta|esta|custa|sai)|manda o valor|passa o valor)\b/,
    /\b(ainda )?(ta |esta )?disponivel\b/,
    /\baceita (troca|proposta|carro)\b/,
    /\b(faz|aceita|tem) financiamento\b|\bfinancia\?/,
    /\b(qual a )?(entrada|parcela)\b.*\?/,
    /\btenho interesse\b/,
    /\b(me chama|chama no (privado|pv|zap|whats|direct|dm))\b/,
  ],
  seller: [
    /\b(vendo|vende-se|vende se|a venda)\b/,
    /\brepass(e|o)\b/,
    /\baceito (troca|proposta|cartao)\b/,
    /\bvalor:?\s*r?\$/,
    /\b(ipva pago|documento ok|abaixo da fipe)\b/,
    /\b(temos|tenho) em estoque\b|\bfinanciamos\b/,
  ],
  context:
    /\b(carro|veiculo|moto|suv|sedan|hatch|picape|pickup|caminhonete|seminovo|usado|0km|zero km|fipe|gol|onix|hb20|strada|toro|hilux|s10|ranger|corolla|civic|argo|mobi|kwid|polo|virtus|t-cross|nivus|compass|renegade|tracker|creta|kicks|sandero|logan|fiesta|ka|uno|palio|siena|saveiro|fiorino|spin|cobalt|prisma|celta|corsa|fox|up|voyage|etios|yaris|hr-v|hrv|fit|city|duster|oroch|208|2008|c3|cronos|pulse|fastback|montana)\b/,
  // Someone shopping for parts or a service for a car they already own.
  exclude:
    /\b(pecas?|pneus?|rodas?|som automotivo|mecanic[oa]s?|oficina|funilaria|lanternagem|seguro|guincho|despachante|emplacamento|lavagem|insulfilm|emprego|vaga)\b/,
};

/** Built-in verticals. Add a lexicon here to support another market. */
export const LEXICONS: Record<string, IntentLexicon> = { generic: GENERIC, car: CAR };

const strip = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function budgetOf(t: string): number | null {
  const m = t.match(/\b(?:ate|up to|under|budget(?: of)?)\s*(r\$\s*|\$\s*)?(\d{1,3}(?:[.,]\d{3})*|\d+)\s*(mil|k)?\b/);
  if (!m) return null;
  const n = Number(m[2].replace(/[.,]/g, ""));
  if (m[3]) return n * 1000;
  // "até 2015" is a model year, not R$ 2.015.
  return n >= 1000 && !(n >= 1950 && n <= 2035 && !m[1]) ? n : null;
}

/**
 * @param vertical a key of LEXICONS (default "generic"); unknown keys throw.
 * @param regions place names the seller covers, e.g. a client's metro area;
 *   a match raises the score and is reported.
 */
export function scorePurchaseIntent(text: string, vertical = "generic", regions: string[] = []): PurchaseIntent {
  const lex = Object.hasOwn(LEXICONS, vertical) ? LEXICONS[vertical] : undefined;
  if (!lex) throw new Error(`Unknown vertical "${vertical}". Available: ${Object.keys(LEXICONS).join(", ")}`);
  const t = strip(text || "");
  const hits = (rules: RegExp[]) => rules.map((r) => t.match(r)?.[0]).filter((m): m is string => !!m);
  const buyer = hits(lex.buyer);
  const question = hits(lex.question);
  const seller = hits(lex.seller);
  const budget = budgetOf(t);
  const hasContext = !lex.context || lex.context.test(t) || budget !== null;
  const region = regions
    .map(strip)
    .sort((a, b) => b.length - a.length) // "vila nova do sul" before "vila nova"
    .find((r) => new RegExp(`\\b${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)) ?? null;

  let kind: IntentKind = "none";
  // A buyer needs context ("procuro emprego" is not a lead); a buyer with a trade-in still wins over "vendo".
  if (buyer.length && hasContext && !lex.exclude?.test(t)) kind = "buyer";
  else if (seller.length) kind = "seller";
  else if (question.length) kind = "price_question";

  const base = { buyer: 75, price_question: 50, seller: 0, none: 0 }[kind];
  const isLead = kind === "buyer" || kind === "price_question";
  const score = isLead ? Math.min(100, base + (region ? 15 : 0) + (budget ? 10 : 0)) : 0;
  return { kind, isLead, score, matched: [...buyer, ...question, ...seller], region, budget };
}

/** Car vertical shortcut, kept for existing callers. */
export const scoreCarPurchaseIntent = (text: string, regions: string[] = []) => scorePurchaseIntent(text, "car", regions);

export interface SocialItem {
  author?: string;
  user?: string;
  authorUrl?: string;
  text: string;
  url?: string;
  postUrl?: string;
  comments?: SocialItem[];
}

export interface ScoredLead {
  author: string;
  authorUrl: string;
  text: string;
  url: string;
  intent: PurchaseIntent;
}

/** Score posts and their nested comments (lookacrawler `social` output); leads only, best first. */
export function scoreSocialItems(items: SocialItem[], opts: { all?: boolean; regions?: string[]; vertical?: string } = {}): ScoredLead[] {
  const out: ScoredLead[] = [];
  const visit = (it: SocialItem, parentUrl: string) => {
    const url = it.url || it.postUrl || parentUrl;
    const intent = scorePurchaseIntent(it.text, opts.vertical, opts.regions);
    if (opts.all || intent.isLead) {
      out.push({ author: it.author || it.user || "", authorUrl: it.authorUrl || "", text: it.text, url, intent });
    }
    for (const c of it.comments || []) visit(c, url);
  };
  for (const it of items) visit(it, "");
  return out.sort((a, b) => b.intent.score - a.intent.score);
}
