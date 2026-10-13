/**
 * Deterministic growth plan from a CompetitiveAnalysis: SEO keywords/meta,
 * a one-week content plan and an outreach playbook. Templates are niche-driven
 * (pt-BR default, English with locale "en"). Proof lines only cite what the
 * analysis observed; anything we cannot know is left as a [bracketed] slot for
 * the operator. Every piece of copy is linted by anti-slop-linter.
 */

import { lintAntiSlop, sanitizeCopy } from "./anti-slop-linter.js";
import { analyzeCompetitors, auditCompanyWebsite, type CompetitiveAnalysis, type Locale, type SiteAudit } from "./competitor-intelligence.js";

export interface ContentBrief {
  day: string;
  channel: string;
  theme: string;
  hook: string;
  proof: string;
  mechanism: string;
  callToAction: string;
  gapAddressed: string;
  slopScore: number;
}

export interface OutreachScript {
  channel: "WhatsApp" | "Email" | "Instagram DM" | "FollowUp";
  targetRole: string;
  subject?: string;
  body: string;
  slopScore: number;
}

export interface GrowthPlan {
  companyName: string;
  niche: string;
  location: string;
  locale: Locale;
  summary: { competitorsTracked: number; advantage: string; biggestGap: string };
  seo: {
    keywords: Array<{ keyword: string; intent: "commercial" | "transactional"; priority: "high" | "medium" }>;
    metaTitle: string;
    metaDescription: string;
    fixFirst: string[];
  };
  weeklyContentPlan: ContentBrief[];
  outreachPlaybook: OutreachScript[];
  verification: { itemsChecked: number; allPassedAntiSlop: boolean; averageSlopScore: number };
}

interface Ctx {
  company: string;
  niche: string;
  loc: string;
  service: string;
  service2: string;
  n: number;
  gap: string;
  /** Operator slot for facts we cannot observe. */
  slot: string;
  /** Reply channel; WhatsApp only when observed on the site. */
  channel: string;
}

const T = {
  pt: {
    days: ["Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira"],
    channels: ["Instagram", "Google Meu Negócio", "WhatsApp Status", "Instagram", "LinkedIn"],
    fallbackServices: (niche: string) => [niche, `atendimento de ${niche}`, `orçamento de ${niche}`],
    metaTitle: (c: string, n: string, l: string) => `${c} | ${n} em ${l}`,
    metaDesc: (c: string, l: string, s: string[]) => `${c} em ${l}: ${s.join(", ")}.`,
    keywords: (n: string, l: string, s: string) => [
      [`${n} em ${l}`, "commercial", "high"],
      [`${s} ${l}`, "transactional", "high"],
      [`preço ${s} ${l}`, "transactional", "high"],
      [`agendamento ${n} ${l}`, "transactional", "medium"],
      [`melhor ${n} em ${l}`, "commercial", "medium"],
    ] as const,
    slot: "[inclua um número real do seu histórico]",
    channelSlot: "[seu canal de atendimento]",
    gapDefault: "Demora de retorno nos canais digitais",
    posts: (c: Ctx) => [
      { theme: `O que olhar antes de escolher ${c.niche} em ${c.loc}`, hook: `Antes de fechar com um(a) ${c.niche} em ${c.loc}, compare três coisas: resposta, preço claro e avaliações recentes.`, proof: `Olhamos ${c.n} concorrentes da região: ${c.gap}.`, mechanism: `Na ${c.company}, o primeiro retorno sai por ${c.channel}, com horários e valores à vista.`, callToAction: `Chame por ${c.channel} pelo link da bio e veja os horários livres desta semana.`, gap: c.gap },
      { theme: `${c.service}: como funciona na prática`, hook: `Procurando ${c.service} em ${c.loc}? Veja como é o passo a passo.`, proof: `Número de atendimentos de ${c.service} no último mês: ${c.slot}.`, mechanism: `Explicamos cada etapa antes de começar, sem termo técnico desnecessário.`, callToAction: `Clique em agendar no perfil ou ligue para reservar seu horário.`, gap: "Falta de clareza sobre o serviço nos concorrentes" },
      { theme: `Bastidores: como organizamos os horários`, hook: `Horário marcado é horário respeitado.`, proof: `Tempo médio de espera na recepção: ${c.slot}.`, mechanism: `Confirmamos por mensagem um dia antes e reservamos intervalos entre atendimentos.`, callToAction: `Responda este status com QUERO para receber as datas do mês.`, gap: "Reclamações de atraso e fila" },
      { theme: `Dúvida frequente sobre ${c.service2}`, hook: `A pergunta que mais recebemos sobre ${c.service2}: quanto tempo leva e o que muda na rotina?`, proof: `Respondemos a dúvida com base em casos reais: ${c.slot}.`, mechanism: `Resposta curta, em linguagem simples, com o que esperar em cada fase.`, callToAction: `Mande sua dúvida por direct que respondemos hoje.`, gap: "Comunicação difícil e jargão nos concorrentes" },
      { theme: `Atendimento fora do horário comercial em ${c.loc}`, hook: `Muita gente pesquisa ${c.niche} à noite, quando a recepção já fechou.`, proof: `Pedidos que chegaram fora do horário comercial no último mês: ${c.slot}.`, mechanism: `Um canal de WhatsApp com resposta automática de horários captura esse público sem aumentar a equipe.`, callToAction: `Siga o perfil para acompanhar as novidades de ${c.niche} em ${c.loc}.`, gap: "Concorrentes que só atendem em horário comercial" },
    ],
    outreach: (c: Ctx) => [
      { channel: "WhatsApp" as const, targetRole: "Lead de entrada", body: `Olá! Aqui é da ${c.company}, em ${c.loc}.\n\nVi seu contato sobre ${c.service}. Tenho horários livres nesta semana.\n\nPrefere manhã ou tarde?` },
      { channel: "Instagram DM" as const, targetRole: "Seguidor que interagiu", body: `Olá! Obrigado por interagir com nosso conteúdo sobre ${c.service}.\n\nPara passar valores e horários em ${c.loc}, prefere conversar por aqui ou direto no WhatsApp?` },
      { channel: "FollowUp" as const, targetRole: "Contato sem resposta", body: `Olá! Só confirmando se você viu os horários da ${c.company} para ${c.service}.\n\nSe preferir outra semana ou tirar uma dúvida antes, é só avisar por aqui.` },
      { channel: "Email" as const, targetRole: "Parceiro ou empresa local", subject: `Parceria em ${c.niche} - ${c.company}`, body: `Olá,\n\nA ${c.company} atende ${c.niche} em ${c.loc}, com foco em ${c.service}.\n\nEmpresas da região costumam valorizar horário prioritário e atendimento sem burocracia. Posso apresentar uma proposta em 5 minutos esta semana?` },
    ],
  },
  en: {
    days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    channels: ["Instagram", "Google Business Profile", "WhatsApp Status", "Instagram", "LinkedIn"],
    fallbackServices: (niche: string) => [niche, `${niche} service`, `${niche} quote`],
    metaTitle: (c: string, n: string, l: string) => `${c} | ${n} in ${l}`,
    metaDesc: (c: string, l: string, s: string[]) => `${c} in ${l}: ${s.join(", ")}.`,
    keywords: (n: string, l: string, s: string) => [
      [`${n} in ${l}`, "commercial", "high"],
      [`${s} ${l}`, "transactional", "high"],
      [`${s} ${l} price`, "transactional", "high"],
      [`book ${n} ${l}`, "transactional", "medium"],
      [`best ${n} in ${l}`, "commercial", "medium"],
    ] as const,
    slot: "[add a real number from your records]",
    channelSlot: "[your reply channel]",
    gapDefault: "Slow replies on digital channels",
    posts: (c: Ctx) => [
      { theme: `What to check before choosing ${c.niche} in ${c.loc}`, hook: `Before you pick a ${c.niche} in ${c.loc}, compare three things: reply time, clear pricing and recent reviews.`, proof: `We looked at ${c.n} local competitors: ${c.gap}.`, mechanism: `At ${c.company}, the first reply goes out on ${c.channel}, with times and prices up front.`, callToAction: `Message us on ${c.channel} from the bio link to see this week's open slots.`, gap: c.gap },
      { theme: `${c.service}: how it works in practice`, hook: `Looking for ${c.service} in ${c.loc}? Here is the step-by-step.`, proof: `${c.service} jobs completed last month: ${c.slot}.`, mechanism: `We explain each step before we start, without unnecessary jargon.`, callToAction: `Tap book in the profile or call to reserve your slot.`, gap: "Unclear service descriptions at competitors" },
      { theme: `Behind the scenes: how we schedule`, hook: `A booked time is a respected time.`, proof: `Average wait time at reception: ${c.slot}.`, mechanism: `We confirm by message the day before and leave gaps between appointments.`, callToAction: `Reply to this status with BOOK to get this month's dates.`, gap: "Complaints about delays and queues" },
      { theme: `Common question about ${c.service2}`, hook: `The question we hear most about ${c.service2}: how long does it take and what changes?`, proof: `We answer from real cases: ${c.slot}.`, mechanism: `Short answer, plain language, what to expect at each stage.`, callToAction: `Send your question by DM and we reply today.`, gap: "Hard-to-read communication at competitors" },
      { theme: `Out-of-hours service in ${c.loc}`, hook: `Plenty of people search for ${c.niche} at night, after reception has closed.`, proof: `Requests received outside business hours last month: ${c.slot}.`, mechanism: `A WhatsApp line with an automatic reply listing open times catches them without adding staff.`, callToAction: `Follow the profile for ${c.niche} news in ${c.loc}.`, gap: "Competitors that only answer in business hours" },
    ],
    outreach: (c: Ctx) => [
      { channel: "WhatsApp" as const, targetRole: "Inbound lead", body: `Hi! This is ${c.company} in ${c.loc}.\n\nI saw your message about ${c.service}. I have openings this week.\n\nMorning or afternoon?` },
      { channel: "Instagram DM" as const, targetRole: "Follower who engaged", body: `Hi! Thanks for engaging with our ${c.service} content.\n\nFor prices and times in ${c.loc}, would you rather chat here or on WhatsApp?` },
      { channel: "FollowUp" as const, targetRole: "No reply yet", body: `Hi! Just checking you saw the ${c.company} times for ${c.service}.\n\nIf another week suits you better, or you have a question first, tell me here.` },
      { channel: "Email" as const, targetRole: "Local partner or business", subject: `${c.niche} partnership - ${c.company}`, body: `Hello,\n\n${c.company} provides ${c.niche} in ${c.loc}, focused on ${c.service}.\n\nLocal businesses tend to value priority slots and no paperwork. Can I walk you through a proposal in 5 minutes this week?` },
    ],
  },
};

export function generateGrowthPlan(analysis: CompetitiveAnalysis): GrowthPlan {
  const { audit, niche, location, competitors, marketGaps, locale } = analysis;
  const t = T[locale];
  const company = audit.companyName;
  const services = audit.services.length ? audit.services.slice(0, 3) : t.fallbackServices(niche);
  const gap = marketGaps.conversionGaps[0] || t.gapDefault;

  const ctx: Ctx = {
    company, niche, loc: location, service: services[0], service2: services[1] || services[0],
    n: competitors.filter((c) => c.siteReviewed || !c.websiteUrl).length, gap, slot: t.slot,
    // Only claim WhatsApp when the audit saw it on the site.
    channel: audit.conversion.hasWhatsApp ? "WhatsApp" : t.channelSlot,
  };

  const score = (text: string) => lintAntiSlop(text, locale).slopScore;
  const clean = sanitizeCopy;

  const weeklyContentPlan: ContentBrief[] = t.posts(ctx).map((p, i) => {
    const brief = { hook: clean(p.hook), proof: clean(p.proof), mechanism: clean(p.mechanism), callToAction: clean(p.callToAction) };
    return {
      day: t.days[i], channel: t.channels[i], theme: p.theme, ...brief, gapAddressed: p.gap,
      slopScore: score(`${brief.hook} ${brief.proof} ${brief.mechanism} ${brief.callToAction}`),
    };
  });

  const outreachPlaybook: OutreachScript[] = t.outreach(ctx).map((s) => {
    const body = clean(s.body);
    return { ...s, body, slopScore: score(body) };
  });

  const scores = [...weeklyContentPlan, ...outreachPlaybook].map((x) => x.slopScore);
  return {
    companyName: company,
    niche,
    location,
    locale,
    summary: { competitorsTracked: competitors.length, advantage: marketGaps.positioningAdvantage, biggestGap: gap },
    seo: {
      keywords: t.keywords(niche, location, services[0]).map(([keyword, intent, priority]) => ({ keyword, intent, priority })),
      metaTitle: t.metaTitle(company, niche, location),
      metaDescription: t.metaDesc(company, location, services),
      fixFirst: audit.seoIssues.slice(0, 5),
    },
    weeklyContentPlan,
    outreachPlaybook,
    verification: {
      itemsChecked: scores.length,
      allPassedAntiSlop: scores.every((s) => s < 25),
      averageSlopScore: Math.round(scores.reduce((a, b) => a + b, 0) / (scores.length || 1)),
    },
  };
}

export interface GrowthEngineOptions {
  websiteUrl: string;
  companyName?: string;
  niche: string;
  location: string;
  maxCompetitors?: number;
  locale?: Locale;
}

/** Audit the site, review local competitors, build the plan. */
export async function runGrowthEngine(options: GrowthEngineOptions): Promise<{
  audit: SiteAudit;
  analysis: CompetitiveAnalysis;
  plan: GrowthPlan;
  executionTimeMs: number;
}> {
  const start = Date.now();
  const audit = await auditCompanyWebsite(options.websiteUrl, { companyName: options.companyName });
  const analysis = await analyzeCompetitors(audit, options.niche, options.location, {
    maxCompetitors: options.maxCompetitors,
    locale: options.locale,
  });
  return { audit, analysis, plan: generateGrowthPlan(analysis), executionTimeMs: Date.now() - start };
}
