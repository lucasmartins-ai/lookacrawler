/**
 * Looka Anti-AI-Slop Deterministic Linter & Style Sanitizer
 *
 * Grounded in open-source Anti-Slop research (adewale/anti-slop-writing,
 * no-ai-slop, Paul Graham essays, and direct-response copywriting principles).
 *
 * Enforces:
 * 1. Zero tolerance for hollow significance amplifiers ("revolucionário", "game-changer", "delve")
 * 2. Ban on throat-clearing generic openings ("No mundo dinâmico de hoje", "In the rapidly evolving...")
 * 3. Ban on mechanical syntactical tropes ("Não se trata apenas de X, mas de Y", "It's not just X, but Y")
 * 4. Grounding verification: demands concrete metrics, real entities, or verifiable mechanisms
 * 5. Formatting cleanliness: rejects excessive emojis and em-dash cascades
 */

export interface SlopViolation {
  category: "banned_word" | "throat_clearing" | "false_antithesis" | "hollow_claim" | "formatting";
  matched: string;
  rule: string;
  suggestion: string;
  index: number;
}

export interface AntiSlopLintResult {
  isSlop: boolean;
  slopScore: number; // 0 = completely clean and grounded, 100 = pure AI slop
  violationsCount: number;
  violations: SlopViolation[];
  metrics: {
    wordCount: number;
    concreteNumbersCount: number;
    sentencesCount: number;
    averageSentenceLength: number;
    hasConcreteGrounding: boolean;
  };
}

/**
 * Portuguese banned words and hollow buzzwords
 */
export const BANNED_WORDS_PT: Array<{ pattern: RegExp; rule: string; suggestion: string }> = [
  {
    pattern: /\b(no mundo din[aâ]mico de hoje|no cen[aá]rio atual|na era digital)\b/gi,
    rule: "Abertura clichê de IA (throat-clearing)",
    suggestion: "Vá direto ao ponto ou ao fato concreto",
  },
  {
    pattern: /\b(revolucion[aá]ri[ao]s?|divisor de [aá]guas|disruptiv[ao]s?)\b/gi,
    rule: "Hipérbole vazia sem dados comprobatórios",
    suggestion: "Descreva o resultado específico em números ou tempo economizado",
  },
  {
    pattern: /\b(elevar\s+(seu|o)\s+neg[oó]cio ao pr[oó]ximo (n[ií]vel|patamar))\b/gi,
    rule: "Chavão corporativo de IA",
    suggestion: "Especifique o crescimento: 'aumentar o faturamento em X%' ou 'reduzir no-shows'",
  },
  {
    pattern: /\b(desbloquear\s+(o\s+)?potencial|liberar\s+o\s+potencial)\b/gi,
    rule: "Metáfora de IA vazia ('unlock the potential')",
    suggestion: "Explicite a ação técnica ou comercial real",
  },
  {
    pattern: /\b(mergulhar\s+(fundo|em)|vamos\s+mergulhar)\b/gi,
    rule: "Tradução literal do vício em inglês ('delve into')",
    suggestion: "Use 'analisar', 'verificar' ou entre direto no assunto",
  },
  {
    pattern: /(?<![\p{L}\d])(vale\s+(a\s+pena\s+)?destacar(\s+que)?|[eé]\s+importante\s+(notar|ressaltar)\s+que)\b/giu,
    rule: "Sinalizador de transição desnecessário (filler)",
    suggestion: "Elimine a introdução e declare o fato diretamente",
  },
  {
    pattern: /\b(sinergia|ecossistema\s+inovador|solu[cç][aã]o\s+robusta|de\s+ponta)\b/gi,
    rule: "Jargão oco sem diferenciação técnica",
    suggestion: "Explique como funciona o mecanismo ou cite uma funcionalidade real",
  },
  {
    pattern: /\b(empoderar|empoderamento)\b/gi,
    rule: "Buzzword vago ('empower')",
    suggestion: "Diga quem faz o que: 'permite que a recepcionista confirme' etc.",
  },
  {
    pattern: /\b(em\s+suma|em\s+conclus[aã]o|para\s+finalizar)\b/gi,
    rule: "Fechamento mecânico de redação escolar de IA",
    suggestion: "Faça uma chamada para ação clara (CTA) ou encerre no dado final",
  },
  {
    pattern: /\b(um\s+testemunho\s+d[eo]|um\s+verdadeiro\s+testemunho)\b/gi,
    rule: "Tradução do calque 'testament to'",
    suggestion: "Use 'comprova que' ou 'mostra que'",
  },
  {
    pattern: /\b(tape[cç]aria|mosaico\s+de)\b/gi,
    rule: "Metáfora artificial de IA ('tapestry')",
    suggestion: "Use termos precisos como 'conjunto', 'histórico' ou 'rede'",
  },
];

/**
 * English banned words and hollow buzzwords
 */
export const BANNED_WORDS_EN: Array<{ pattern: RegExp; rule: string; suggestion: string }> = [
  {
    pattern: /\b(in today['’]?s\s+(fast-paced|rapidly\s+evolving|digital)\s+(world|landscape|age))\b/gi,
    rule: "AI throat-clearing cliché",
    suggestion: "Start immediately with the specific fact or problem",
  },
  {
    pattern: /\b(delve(\s+into)?|delving)\b/gi,
    rule: "Classic ChatGPT signature vocabulary",
    suggestion: "Use 'examine', 'inspect', or go directly to the topic",
  },
  {
    pattern: /\b(game-changer|revolutionary|disruptive)\b/gi,
    rule: "Hollow hyperbolic assertion",
    suggestion: "Provide concrete numbers, time saved, or dollar figures",
  },
  {
    pattern: /\b(tapestry|beacon|testament to)\b/gi,
    rule: "Overused florid AI metaphors",
    suggestion: "Use concrete nouns grounded in reality",
  },
  {
    pattern: /\b(unlock(ing)?\s+(the\s+)?potential|elevate\s+your\s+business)\b/gi,
    rule: "Generic marketing fluff",
    suggestion: "State the measurable outcome (e.g. 'gain 15 private patients/mo')",
  },
  {
    pattern: /\b(it['’]?s\s+worth\s+noting(\s+that)?|it\s+is\s+important\s+to\s+remember)\b/gi,
    rule: "Filler signposting",
    suggestion: "State the fact directly without preamble",
  },
  {
    pattern: /\b(supercharge|harness\s+the\s+power\s+of)\b/gi,
    rule: "Vague power-word clichés",
    suggestion: "Explain the mechanical benefit",
  },
  {
    pattern: /\b(in\s+conclusion|furthermore|moreover)\b/gi,
    rule: "Mechanical academic transition words in commercial copy",
    suggestion: "Keep sentences punchy and conversational",
  },
];

/**
 * Mechanical Tropes Checkers
 */
export const MECHANICAL_PATTERNS: Array<{ pattern: RegExp; rule: string; suggestion: string }> = [
  {
    pattern: /\b(n[aã]o\s+(se\s+trata|é)\s+apenas\s+(de\s+)?.+?,\s*mas\s+(sim\s+)?(de\s+)?)/gi,
    rule: "Antítese mecânica ('Não é apenas X, mas sim Y')",
    suggestion: "Declare a tese afirmativa diretamente sem o artifício retórico",
  },
  {
    pattern: /\b(it['’]?s\s+not\s+just\s+about\s+.+?,\s*it['’]?s\s+about\s+)/gi,
    rule: "Mechanical antithesis ('It's not just about X, it's about Y')",
    suggestion: "State what it is directly without contrasting it against a strawman",
  },
];

/**
 * Lint text against the Looka Anti-AI-Slop Standard
 */
export function lintAntiSlop(text: string, language: "pt" | "en" | "auto" = "auto"): AntiSlopLintResult {
  if (!text || text.trim().length === 0) {
    return {
      isSlop: false,
      slopScore: 0,
      violationsCount: 0,
      violations: [],
      metrics: {
        wordCount: 0,
        concreteNumbersCount: 0,
        sentencesCount: 0,
        averageSentenceLength: 0,
        hasConcreteGrounding: false,
      },
    };
  }

  const violations: SlopViolation[] = [];

  // Determine language rules to apply
  const rulesToApply = [];
  if (language === "pt" || language === "auto") {
    rulesToApply.push(...BANNED_WORDS_PT);
  }
  if (language === "en" || language === "auto") {
    rulesToApply.push(...BANNED_WORDS_EN);
  }
  rulesToApply.push(...MECHANICAL_PATTERNS);

  for (const item of rulesToApply) {
    const regex = new RegExp(item.pattern.source, item.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      violations.push({
        category: /Antítese|antithesis/i.test(item.rule) ? "false_antithesis" : "banned_word",
        matched: match[0],
        rule: item.rule,
        suggestion: item.suggestion,
        index: match.index,
      });
    }
  }

  // Formatting check: excessive emojis (more than 1 emoji per 40 words or 3+ emojis in a row)
  const emojiRegex = /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
  const emojiMatches = text.match(emojiRegex) || [];
  const words = text.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  if (wordCount > 20 && emojiMatches.length > Math.ceil(wordCount / 25)) {
    violations.push({
      category: "formatting",
      matched: `${emojiMatches.length} emojis em ${wordCount} palavras`,
      rule: "Excesso de emojis decorativos (fingerprint de bot de IA)",
      suggestion: "Limite os emojis a no máximo 1 por mensagem ou elimine-os para manter tom profissional",
      index: 0,
    });
  }

  // Grounding check: count concrete numbers, percentages, currency, ratings or explicit metrics
  const numberRegex = /\b(\d+([.,]\d+)?%?|\$\d+|\d+\s*★|CRM[-\s]?[A-Z]{2}|\d{2,}\s*(minutos|dias|horas|anos|pacientes|clientes))\b/gi;
  const numbers = text.match(numberRegex) || [];
  const concreteNumbersCount = numbers.length;

  // Sentences metrics
  const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 5);
  const sentencesCount = Math.max(1, sentences.length);
  const averageSentenceLength = Math.round(wordCount / sentencesCount);

  // Lack of grounding violation: if text is long (> 80 words) and contains zero concrete numbers/metrics
  const hasConcreteGrounding = concreteNumbersCount > 0;
  if (wordCount > 80 && !hasConcreteGrounding) {
    violations.push({
      category: "hollow_claim",
      matched: "Texto sem dados numéricos ou evidências factuais",
      rule: "Falta de ancoragem em dados concretos (Lack of Grounding)",
      suggestion: "Inclua métricas reais: avaliações Google, número de clientes, tempo de resposta ou valores",
      index: 0,
    });
  }

  // Calculate Slop Score (0 to 100)
  // Each banned word adds 25 points, false antithesis adds 30, formatting adds 15, ungrounded adds 20
  let rawScore = 0;
  for (const v of violations) {
    if (v.category === "banned_word") rawScore += 25;
    else if (v.category === "false_antithesis") rawScore += 30;
    else if (v.category === "throat_clearing") rawScore += 25;
    else if (v.category === "hollow_claim") rawScore += 20;
    else if (v.category === "formatting") rawScore += 15;
  }

  // If well-grounded with numbers, give a resilience discount
  if (hasConcreteGrounding && rawScore > 0) {
    rawScore = Math.max(0, rawScore - Math.min(20, concreteNumbersCount * 5));
  }

  const slopScore = Math.min(100, rawScore);
  const isSlop = slopScore >= 25 || violations.length > 0;

  return {
    isSlop,
    slopScore,
    violationsCount: violations.length,
    violations,
    metrics: {
      wordCount,
      concreteNumbersCount,
      sentencesCount,
      averageSentenceLength,
      hasConcreteGrounding,
    },
  };
}

/**
 * Automatically sanitizes common AI slop patterns and returns direct, punchy copy
 */
export function sanitizeCopy(text: string): string {
  let cleaned = text;

  // Remove common throat-clearing openings
  cleaned = cleaned.replace(/^(no mundo din[aâ]mico de hoje|no cen[aá]rio atual|na era digital)[,.\s]*/gi, "");
  cleaned = cleaned.replace(/^(in today['’]?s\s+(fast-paced|rapidly\s+evolving|digital)\s+(world|landscape|age))[,.\s]*/gi, "");

  // Remove filler signposts
  cleaned = cleaned.replace(/(?<![\p{L}\d])(vale\s+destacar\s+que|[eé]\s+importante\s+notar\s+que|it['’]?s\s+worth\s+noting\s+that)\s*/giu, "");

  // Replace buzzwords with simple active forms
  cleaned = cleaned.replace(/\b(revolucion[aá]ri[ao]s?|divisor de [aá]guas)\b/gi, "eficiente");
  cleaned = cleaned.replace(/\b(delve into|mergulhar em)\b/gi, "analisar");
  cleaned = cleaned.replace(/\b(elevar\s+(seu|o)\s+neg[oó]cio ao pr[oó]ximo\s+(n[ií]vel|patamar))\b/gi, "aumentar seus resultados");

  return cleaned.trim();
}
