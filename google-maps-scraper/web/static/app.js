"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const campaignPageSize = 12;
const resultPageSize = 20;
const themeStorageKey = "maps-leads-theme";

let campaignPage = 0;
let resultPage = 0;
let selectedJob = null;
let selectedJobActive = false;
let templates = [];
let geocodeTimer = null;
let geocodeController = null;
let estimateTimer = null;
let toastTimer = null;
let detailRequest = 0;
let locationSearchUnavailable = false;
let manualLocationMode = false;

const statusInfo = {
  queued: { label: "Aguardando", short: "Aguardando" },
  running: { label: "Busca em andamento", short: "Buscando" },
  succeeded: { label: "Busca concluída", short: "Concluída" },
  failed: { label: "Não foi possível concluir", short: "Com erro" },
  timed_out: { label: "Tempo de busca encerrado", short: "Tempo encerrado" },
  canceled: { label: "Busca cancelada", short: "Cancelada" },
  interrupted: { label: "Busca interrompida", short: "Interrompida" },
  worker_lost: { label: "Busca interrompida", short: "Interrompida" },
};

const iconPaths = {
  search: '<circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path>',
  briefcase: '<path d="M9 7V5h6v2M4 8h16v11H4zM4 12h16M10 12v2h4v-2"></path>',
  clock: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
  check: '<path d="m5 12 4 4L19 6"></path>',
  alert:
    '<path d="M12 9v4m0 4h.01M10.3 4.2 2.6 18a1.5 1.5 0 0 0 1.3 2.2h16.2a1.5 1.5 0 0 0 1.3-2.2L13.7 4.2a2 2 0 0 0-3.4 0Z"></path>',
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"></path><path d="M9 3v15M15 6v15"></path>',
  pin: '<path d="M12 21s7-6.1 7-12A7 7 0 0 0 5 9c0 5.9 7 12 7 12Z"></path><circle cx="12" cy="9" r="2.5"></circle>',
  phone:
    '<path d="M7 3H4.5A1.5 1.5 0 0 0 3 4.5C3 13.6 10.4 21 19.5 21a1.5 1.5 0 0 0 1.5-1.5V17l-4-1-1 2a13 13 0 0 1-10-10l2-1-1-4Z"></path>',
  globe:
    '<circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3c3 3.3 3 14.7 0 18M12 3c-3 3.3-3 14.7 0 18"></path>',
  mail: '<path d="M3 5h18v14H3z"></path><path d="m3 6 9 7 9-7"></path>',
  instagram:
    '<rect x="3" y="3" width="18" height="18" rx="5"></rect><circle cx="12" cy="12" r="4"></circle><circle cx="17.5" cy="6.5" r="1"></circle>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 20h16"></path>',
  dots: '<circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle>',
  filter: '<path d="M4 5h16l-6 7v5l-4 2v-7L4 5Z"></path>',
  arrow: '<path d="m9 18 6-6-6-6"></path>',
  building:
    '<path d="M4 21V6l8-3 8 3v15M9 9h.01M15 9h.01M9 13h.01M15 13h.01M9 17h6"></path>',
};

function savedTheme() {
  try {
    return localStorage.getItem(themeStorageKey);
  } catch {
    return null;
  }
}

function applyTheme(theme, persist = false) {
  const selected = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = selected;
  document.documentElement.style.colorScheme = selected;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", selected === "dark" ? "#0b1020" : "#101828");
  const button = $("#theme-toggle");
  if (button) {
    const dark = selected === "dark";
    button.setAttribute(
      "aria-label",
      dark ? "Ativar tema claro" : "Ativar tema escuro",
    );
    button.title = dark ? "Usar tema claro" : "Usar tema escuro";
  }
  if (persist) {
    try {
      localStorage.setItem(themeStorageKey, selected);
    } catch {
      // A interface continua funcional quando o armazenamento está bloqueado.
    }
  }
}

applyTheme(savedTheme() || "light");

function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name] || iconPaths.search}</svg>`;
}

function esc(value) {
  return String(value ?? "").replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        character
      ],
  );
}

function translateError(message) {
  const text = String(message || "Ocorreu um problema inesperado.");
  const translations = [
    ["results are not available", "Os resultados ainda não estão disponíveis."],
    ["could not read results", "Não foi possível abrir os resultados."],
    [
      "geocoding service unavailable",
      "A busca de locais está temporariamente indisponível. Tente novamente em instantes.",
    ],
    [
      "geocoding is temporarily paused",
      "A busca de locais está temporariamente pausada. Tente novamente em um minuto.",
    ],
    [
      "query must contain",
      "Digite pelo menos 3 caracteres para procurar o local.",
    ],
    ["missing keywords", "Informe pelo menos um tipo de empresa ou serviço."],
    ["keyword exceeds", "Cada termo pode ter no máximo 300 caracteres."],
    ["too many keywords", "Use no máximo 100 termos por busca."],
    ["location exceeds", "O nome do local informado é muito longo."],
    ["invalid language code", "O idioma configurado não é válido."],
    ["depth must be", "Escolha um nível de busca válido."],
    ["radius must be", "Escolha uma distância de busca válida."],
    ["max_time", "Escolha um limite de tempo válido."],
    [
      "latitude and longitude are required",
      "Escolha um local nas sugestões antes de iniciar.",
    ],
    [
      "could not create campaign",
      "Não foi possível iniciar a busca. Tente novamente.",
    ],
    ["campaign not found", "Essa busca não foi encontrada."],
    ["not found", "O item solicitado não foi encontrado."],
    ["job cannot be canceled", "Esta busca não pode mais ser cancelada."],
    ["job cannot be retried", "Esta busca não pode ser reiniciada."],
    ["retention failed", "Não foi possível concluir a limpeza."],
    [
      "too many requests",
      "Muitas ações em pouco tempo. Aguarde alguns segundos.",
    ],
    [
      "request origin",
      "A solicitação foi bloqueada por segurança. Atualize a página e tente novamente.",
    ],
    ["invalid JSON", "Os dados enviados não são válidos."],
  ];
  const found = translations.find(([source]) =>
    text.toLowerCase().includes(source.toLowerCase()),
  );
  return found ? found[1] : text;
}

async function api(path, options = {}) {
  const request = {
    ...options,
    headers: { Accept: "application/json", ...(options.headers || {}) },
  };
  if (request.body && !(request.body instanceof FormData)) {
    request.headers["Content-Type"] = "application/json";
    if (typeof request.body !== "string")
      request.body = JSON.stringify(request.body);
  }
  const response = await fetch(path, request);
  const type = response.headers.get("content-type") || "";
  const data = type.includes("json")
    ? await response.json()
    : await response.text();
  if (!response.ok)
    throw new Error(
      translateError(data?.message || data || `Erro ${response.status}`),
    );
  return data;
}

function toast(message, type = "success") {
  const element = $("#toast");
  clearTimeout(toastTimer);
  $("#toast-text").textContent = message;
  $("#toast-icon").textContent = type === "error" ? "!" : "✓";
  element.classList.toggle("error", type === "error");
  element.classList.add("show");
  toastTimer = setTimeout(() => element.classList.remove("show"), 4200);
}

function setButtonLoading(button, loading) {
  if (!button) return;
  button.classList.toggle("loading", loading);
  button.disabled = loading;
}

function view(name) {
  if (name !== "detail") selectedJobActive = false;
  $$(".view").forEach((element) =>
    element.classList.toggle("hidden", element.id !== name),
  );
  $$("[data-nav]").forEach((button) =>
    button.classList.toggle(
      "active",
      button.dataset.nav === (name === "detail" ? "dashboard" : name),
    ),
  );
  if (name === "dashboard") loadJobs();
  if (name === "new") {
    loadTemplates();
    setTimeout(() => $("#keywords")?.focus(), 80);
  }
  $("#conteudo").focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
      .format(new Date(value))
      .replace(".", "");
  } catch {
    return "Data indisponível";
  }
}

function number(value) {
  return new Intl.NumberFormat("pt-BR").format(Number(value) || 0);
}

function keywordsFromForm() {
  const seen = new Set();
  return String($("#keywords").value || "")
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => {
      const key = item.toLocaleLowerCase("pt-BR");
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function generatedName(keywords, location) {
  const term = keywords[0] || "Nova busca";
  const place = String(location || "")
    .split(",")
    .slice(0, 2)
    .join(",")
    .trim();
  return place ? `${term} em ${place}` : term;
}

function formPayload() {
  const form = $("#job-form").elements;
  const keywords = keywordsFromForm();
  const location = String(form.location.value || "").trim();
  const depth = Number(form.depth.value || 25);
  return {
    name:
      String(form.name.value || "").trim() || generatedName(keywords, location),
    data: {
      keywords,
      location,
      lang: "pt-BR",
      depth,
      max_time_minutes: depth >= 50 ? 60 : 30,
      zoom: 15,
      lat: form.lat.value,
      lon: form.lon.value,
      radius: Number(form.radius.value || 10000),
      fast_mode: Boolean(form.lat.value && form.lon.value),
      email: form.email.checked,
      extra_reviews: form.extra_reviews.checked,
      proxies: [],
    },
  };
}

function updateFormSummary() {
  const payload = formPayload();
  const terms = payload.data.keywords;
  $("#keyword-count").textContent =
    `${terms.length} ${terms.length === 1 ? "termo" : "termos"}`;
  $("#review-keywords").textContent = terms.length
    ? terms.length === 1
      ? terms[0]
      : `${terms[0]} e mais ${terms.length - 1}`
    : "Ainda não informado";
  $("#review-location").textContent =
    (payload.data.lat && payload.data.lon) || manualLocationMode
      ? payload.data.location
      : "Ainda não informado";
  $("#review-radius").textContent =
    `Até ${number(payload.data.radius / 1000)} km`;
  scheduleEstimate();
}

function scheduleEstimate() {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(updateEstimate, 450);
}

async function updateEstimate() {
  const payload = formPayload();
  if (
    !payload.data.keywords.length ||
    (!manualLocationMode && (!payload.data.lat || !payload.data.lon))
  ) {
    $("#estimate").innerHTML =
      '<span class="estimate-dot"></span><span>Preencha os campos para iniciar.</span>';
    return;
  }
  try {
    const data = await api("/api/v1/estimate", {
      method: "POST",
      body: payload.data,
    });
    const minutes = Math.max(1, Number(data.estimated_minutes) || 1);
    $("#estimate").innerHTML =
      `<span class="estimate-dot"></span><span>Configuração pronta. Tempo estimado a partir de ${number(minutes)} ${minutes === 1 ? "minuto" : "minutos"}.</span>`;
  } catch {
    $("#estimate").innerHTML =
      '<span class="estimate-dot"></span><span>Configuração pronta para iniciar.</span>';
  }
}

function clearSelectedLocation() {
  const form = $("#job-form").elements;
  form.lat.value = "";
  form.lon.value = "";
  manualLocationMode = false;
  $("#location-selected").classList.add("hidden");
}

function selectTextLocation() {
  const form = $("#job-form").elements;
  const location = String(form.location.value || "").trim();
  if (!location) return;
  form.lat.value = "";
  form.lon.value = "";
  manualLocationMode = true;
  $("#location-selected").innerHTML =
    `${icon("check")}<span>Local confirmado por texto: ${esc(location)}</span>`;
  $("#location-selected").classList.remove("hidden");
  $("#location-results").classList.add("hidden");
  updateFormSummary();
}

function locationLabel(displayName) {
  const parts = String(displayName || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    title: parts.slice(0, 2).join(", ") || "Local encontrado",
    subtitle: parts.slice(2).join(", "),
  };
}

function selectLocation(result) {
  const form = $("#job-form").elements;
  form.location.value = result.display_name;
  form.lat.value = result.lat;
  form.lon.value = result.lon;
  manualLocationMode = false;
  locationSearchUnavailable = false;
  const label = locationLabel(result.display_name);
  $("#location-selected").innerHTML =
    `${icon("check")}<span>Local confirmado: ${esc(label.title)}</span>`;
  $("#location-selected").classList.remove("hidden");
  $("#location-results").classList.add("hidden");
  updateFormSummary();
}

function renderLocationResults(results) {
  const container = $("#location-results");
  if (!results.length) {
    container.innerHTML = `<div class="location-message"><span>${icon("pin")}</span><div><strong>Não encontramos uma correspondência exata</strong><p>Inclua cidade e estado ou continue usando o local exatamente como digitou.</p><button type="button" data-use-text-location>Usar “${esc($("#location").value.trim())}” mesmo</button></div></div>`;
    container.classList.remove("hidden");
    $("[data-use-text-location]", container)?.addEventListener(
      "click",
      selectTextLocation,
    );
    return;
  }
  container.innerHTML = results
    .map((result, index) => {
      const label = locationLabel(result.display_name);
      const type = result.type || "Local";
      const country = result.country_code ? ` · ${result.country_code}` : "";
      return `<button class="location-option" type="button" data-location-index="${index}">${icon("pin")}<span><strong>${esc(label.title)}</strong><small>${esc(label.subtitle || "Selecione este local")}</small></span><em>${esc(type + country)}</em></button>`;
    })
    .join("");
  container.classList.remove("hidden");
  $$("[data-location-index]", container).forEach((button) => {
    button.onclick = () =>
      selectLocation(results[Number(button.dataset.locationIndex)]);
  });
}

function renderLocationUnavailable() {
  const container = $("#location-results");
  container.innerHTML = `<div class="location-message warning">${icon("alert")}<div><strong>A consulta de mapas está indisponível agora</strong><p>Você ainda pode realizar a busca usando o local digitado diretamente.</p><div><button type="button" data-retry-location>Tentar novamente</button><button type="button" data-use-text-location>Continuar com este local</button></div></div></div>`;
  container.classList.remove("hidden");
  $("[data-retry-location]", container)?.addEventListener("click", () =>
    searchLocation(),
  );
  $("[data-use-text-location]", container)?.addEventListener(
    "click",
    selectTextLocation,
  );
}

async function searchLocation({ quiet = false } = {}) {
  const query = $("#location").value.trim();
  if (query.length < 3) {
    $("#location-results").classList.add("hidden");
    return [];
  }
  if (geocodeController) geocodeController.abort();
  const controller = new AbortController();
  geocodeController = controller;
  locationSearchUnavailable = false;
  $("#location-spinner").classList.remove("hidden");
  try {
    const results = await api(
      `/api/v1/geocode?q=${encodeURIComponent(query)}`,
      { signal: controller.signal },
    );
    renderLocationResults(results);
    return results;
  } catch (error) {
    if (error.name !== "AbortError") {
      locationSearchUnavailable = true;
      if (!quiet) renderLocationUnavailable();
    }
    return [];
  } finally {
    if (geocodeController === controller)
      $("#location-spinner").classList.add("hidden");
  }
}

function queueLocationSearch() {
  clearTimeout(geocodeTimer);
  clearSelectedLocation();
  updateFormSummary();
  if ($("#location").value.trim().length < 3) {
    $("#location-results").classList.add("hidden");
    return;
  }
  geocodeTimer = setTimeout(() => searchLocation(), 800);
}

async function validateSearchForm() {
  const terms = keywordsFromForm();
  if (!terms.length) {
    toast("Informe pelo menos um tipo de empresa ou serviço.", "error");
    $("#keywords").focus();
    return false;
  }
  if (terms.length > 100) {
    toast("Use no máximo 100 termos por busca.", "error");
    $("#keywords").focus();
    return false;
  }
  const form = $("#job-form").elements;
  if (!form.location.value.trim()) {
    toast("Informe a cidade, o bairro ou a região da busca.", "error");
    form.location.focus();
    return false;
  }
  if (!form.lat.value || !form.lon.value) {
    const results = await searchLocation({ quiet: true });
    if (results.length === 1) selectLocation(results[0]);
    if (!form.lat.value || !form.lon.value) {
      if (results.length) {
        toast("Escolha o local correto na lista de sugestões.", "error");
        form.location.focus();
        return false;
      }
      selectTextLocation();
      toast(
        locationSearchUnavailable
          ? "A consulta de mapas falhou, então usaremos o local digitado diretamente."
          : "Usaremos o local digitado diretamente.",
      );
    }
  }
  return true;
}

function renderSummary(data) {
  const summary = data.summary || {};
  const total = Object.values(summary).reduce(
    (sum, value) => sum + Number(value || 0),
    0,
  );
  const active = Number(summary.running || 0) + Number(summary.queued || 0);
  const attention =
    Number(summary.failed || 0) +
    Number(summary.worker_lost || 0) +
    Number(summary.timed_out || 0) +
    Number(summary.interrupted || 0);
  const cards = [
    { icon: "search", value: total, label: "Buscas criadas", tone: "" },
    { icon: "clock", value: active, label: "Em andamento", tone: "orange" },
    {
      icon: "check",
      value: summary.succeeded || 0,
      label: "Concluídas",
      tone: "green",
    },
    {
      icon: "alert",
      value: attention,
      label: "Precisam de atenção",
      tone: "red",
    },
  ];
  $("#summary").innerHTML = cards
    .map(
      (card) =>
        `<div class="metric-card"><span class="metric-icon ${card.tone}">${icon(card.icon)}</span><span class="metric-copy"><strong>${number(card.value)}</strong><span>${card.label}</span></span></div>`,
    )
    .join("");
}

function renderJobs(data) {
  const container = $("#jobs");
  container.setAttribute("aria-busy", "false");
  if (!data.items?.length) {
    const filtered = Boolean($("#status-filter").value);
    container.innerHTML = `<div class="empty-state"><div class="empty-state-content"><span class="empty-icon">${icon(filtered ? "filter" : "search")}</span><h3>${filtered ? "Nenhuma busca nesta situação" : "Sua primeira busca começa aqui"}</h3><p>${filtered ? "Altere o filtro para visualizar outras buscas." : "Encontre empresas por tipo e localização em poucos passos."}</p>${filtered ? "" : '<button class="button button-primary" type="button" data-empty-new>Fazer primeira busca</button>'}</div></div>`;
    $("[data-empty-new]")?.addEventListener("click", () => view("new"));
  } else {
    container.innerHTML = data.items
      .map((job) => {
        const status = statusInfo[job.status] || {
          label: job.status,
          short: job.status,
        };
        const words = (job.data?.keywords || []).slice(0, 2).join(", ");
        const place = job.data?.location || words || "Local não informado";
        const initial = String(job.name || "B")
          .trim()
          .charAt(0)
          .toLocaleUpperCase("pt-BR");
        return `<article class="search-row">
        <div class="search-main"><span class="search-avatar">${esc(initial)}</span><span class="search-main-copy"><strong>${esc(job.name)}</strong><span>${esc(place)}</span></span></div>
        <div><span class="status-pill ${esc(job.status)}">${esc(status.short)}</span></div>
        <div class="search-meta search-date"><span>Criada em</span><strong>${esc(formatDate(job.created_at))}</strong></div>
        <div class="search-meta search-results"><span>Empresas</span><strong>${number(job.results_count)}</strong></div>
        <button class="row-open" type="button" data-open="${esc(job.id)}">Ver busca</button>
      </article>`;
      })
      .join("");
    $$("[data-open]", container).forEach(
      (button) => (button.onclick = () => openJob(button.dataset.open)),
    );
  }
  const pages = Math.ceil(Number(data.total || 0) / campaignPageSize);
  $("#campaign-pager").classList.toggle("hidden", pages <= 1);
  $("#page-label").textContent =
    `Página ${campaignPage + 1} de ${Math.max(1, pages)}`;
  $("#prev-page").disabled = campaignPage === 0;
  $("#next-page").disabled = campaignPage + 1 >= pages;
}

async function loadJobs() {
  try {
    const query = new URLSearchParams({
      limit: campaignPageSize,
      offset: campaignPage * campaignPageSize,
    });
    const status = $("#status-filter").value;
    if (status) query.set("status", status);
    const data = await api(`/api/v1/jobs?${query}`);
    renderSummary(data);
    renderJobs(data);
  } catch (error) {
    $("#jobs").setAttribute("aria-busy", "false");
    $("#jobs").innerHTML =
      `<div class="empty-state"><div class="empty-state-content"><span class="empty-icon">${icon("alert")}</span><h3>Não foi possível carregar as buscas</h3><p>${esc(error.message)}</p><button class="button button-secondary" type="button" data-retry-jobs>Tentar novamente</button></div></div>`;
    $("[data-retry-jobs]")?.addEventListener("click", loadJobs);
  }
}

function resultFilters(withPagination = true) {
  const query = new URLSearchParams();
  if (withPagination) {
    query.set("limit", resultPageSize);
    query.set("offset", resultPage * resultPageSize);
  }
  const values = {
    search: $("#result-search")?.value.trim() || "",
    category: $("#result-category")?.value.trim() || "",
    min_rating: $("#result-rating")?.value || "",
    has_phone: $("#result-phone")?.checked ? "true" : "",
    has_website: $("#result-website")?.checked ? "true" : "",
    has_instagram: $("#result-instagram")?.checked ? "true" : "",
    has_email: $("#result-email")?.checked ? "true" : "",
  };
  Object.entries(values).forEach(([key, value]) => {
    if (value !== "") query.set(key, value);
  });
  return query;
}

function resultObject(headers, row) {
  const item = {};
  headers.forEach((header, index) => {
    item[String(header).trim().toLowerCase()] = row[index] ?? "";
  });
  return item;
}

function firstValue(item, ...keys) {
  for (const key of keys)
    if (String(item[key] || "").trim()) return String(item[key]).trim();
  return "";
}

function compactValue(value, maxLength = 280) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength
    ? `${text.slice(0, maxLength - 1).trimEnd()}…`
    : text;
}

function parsedJSON(value) {
  const text = String(value || "").trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function listValue(value) {
  const parsed = parsedJSON(value);
  const values = Array.isArray(parsed)
    ? parsed
    : String(value || "").split(",");
  return [
    ...new Set(values.map((item) => String(item).trim()).filter(Boolean)),
  ];
}

function categoryValue(item) {
  const primary = firstValue(item, "category");
  if (primary && !["[]", "{}"].includes(primary)) {
    return Array.isArray(parsedJSON(primary))
      ? listValue(primary)[0] || "Categoria não disponível"
      : primary;
  }
  return (
    listValue(firstValue(item, "categories"))[0] || "Categoria não disponível"
  );
}

function hoursValue(value) {
  const parsed = parsedJSON(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return "";
  const dayNames = {
    monday: "Segunda-feira",
    "segunda-feira": "Segunda-feira",
    tuesday: "Terça-feira",
    "terça-feira": "Terça-feira",
    wednesday: "Quarta-feira",
    "quarta-feira": "Quarta-feira",
    thursday: "Quinta-feira",
    "quinta-feira": "Quinta-feira",
    friday: "Sexta-feira",
    "sexta-feira": "Sexta-feira",
    saturday: "Sábado",
    sábado: "Sábado",
    sunday: "Domingo",
    domingo: "Domingo",
  };
  const ordered = [
    "monday",
    "segunda-feira",
    "tuesday",
    "terça-feira",
    "wednesday",
    "quarta-feira",
    "thursday",
    "quinta-feira",
    "friday",
    "sexta-feira",
    "saturday",
    "sábado",
    "sunday",
    "domingo",
  ];
  const source = Object.fromEntries(
    Object.entries(parsed).map(([day, hours]) => [
      day.toLocaleLowerCase("pt-BR"),
      Array.isArray(hours) ? hours : [hours],
    ]),
  );
  const seen = new Set();
  return ordered
    .filter((day) => source[day]?.length && !seen.has(dayNames[day]))
    .map((day) => {
      seen.add(dayNames[day]);
      return `${dayNames[day]}: ${source[day].join(" / ")}`;
    })
    .join(" · ");
}

function ownerValue(value) {
  const parsed = parsedJSON(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return "";
  return String(parsed.name || "").trim();
}

function addressValue(item) {
  const address = firstValue(item, "address");
  if (address) return address;
  const parsed = parsedJSON(firstValue(item, "complete_address"));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
    return "Endereço não disponível";
  return [
    parsed.street,
    parsed.borough,
    parsed.city,
    parsed.state,
    parsed.postal_code,
    parsed.country,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(", ");
}

function socialDomain(value) {
  try {
    const host = new URL(value).hostname.replace(/^www\./, "").toLowerCase();
    const domains = [
      "instagram.com",
      "facebook.com",
      "fb.com",
      "tiktok.com",
      "twitter.com",
      "x.com",
      "linkedin.com",
      "wa.me",
      "whatsapp.com",
      "linktr.ee",
    ];
    return domains.find(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
  } catch {
    return "";
  }
}

function contactURLs(item) {
  let website = safeURL(firstValue(item, "website", "web_site"));
  let instagram = safeURL(firstValue(item, "instagram"));
  if (socialDomain(instagram) !== "instagram.com") instagram = "";
  const websiteSocial = socialDomain(website);
  if (websiteSocial) {
    if (websiteSocial === "instagram.com" && !instagram) instagram = website;
    website = "";
  }
  return { website, instagram };
}

function instagramLabel(value) {
  try {
    const path = new URL(value).pathname.split("/").filter(Boolean)[0];
    return path ? `@${decodeURIComponent(path)}` : "Instagram";
  } catch {
    return "Instagram";
  }
}

function safeURL(value) {
  try {
    let candidate = String(value || "").trim();
    if (candidate && !candidate.includes("://"))
      candidate = `https://${candidate}`;
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function websiteLabel(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

function firstEmail(value) {
  return (
    String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ||
    ""
  );
}

function phoneLink(value) {
  const clean = String(value || "").replace(/[^+\d]/g, "");
  return clean.length >= 8 ? `tel:${clean}` : "";
}

function friendlyDetailItems(item) {
  const fields = [
    ["Horário de funcionamento", "open_hours", hoursValue],
    ["Descrição", "descriptions", compactValue],
    ["Faixa de preço", "price_range", compactValue],
    ["Responsável", "owner", ownerValue],
    [
      "Formas de pagamento",
      "credit_cards_accepted",
      (value) => listValue(value).join(", "),
    ],
  ];
  return fields
    .map(([label, key, formatter]) => ({
      label,
      value: compactValue(formatter(firstValue(item, key))),
    }))
    .filter(
      (entry) => entry.value && entry.value !== "{}" && entry.value !== "[]",
    )
    .slice(0, 6);
}

function renderLeadCard(item) {
  const title = firstValue(item, "title") || "Empresa sem nome";
  const category = categoryValue(item);
  const address = addressValue(item);
  const phone = firstValue(item, "phone", "phone_number");
  const { website, instagram } = contactURLs(item);
  const email = firstEmail(firstValue(item, "emails", "email"));
  const maps = safeURL(firstValue(item, "link"));
  const rating = Number(
    String(firstValue(item, "review_rating", "rating")).replace(",", "."),
  );
  const reviews = firstValue(item, "review_count");
  const initial = title.trim().charAt(0).toLocaleUpperCase("pt-BR");
  const details = friendlyDetailItems(item);
  const ratingHTML = rating
    ? `<div class="lead-rating"><span>★ ${rating.toFixed(1).replace(".", ",")}</span><span>${reviews ? `(${number(reviews)} avaliações)` : ""}</span></div>`
    : "";
  const actions = [
    phoneLink(phone)
      ? `<a class="lead-action" href="${esc(phoneLink(phone))}" title="Ligar para ${esc(title)}" aria-label="Ligar para ${esc(title)}">${icon("phone")}</a>`
      : "",
    website
      ? `<a class="lead-action" href="${esc(website)}" target="_blank" rel="noreferrer" title="Abrir site" aria-label="Abrir site de ${esc(title)}">${icon("globe")}</a>`
      : "",
    instagram
      ? `<a class="lead-action instagram" href="${esc(instagram)}" target="_blank" rel="noreferrer" title="Abrir Instagram" aria-label="Abrir Instagram de ${esc(title)}">${icon("instagram")}</a>`
      : "",
    maps
      ? `<a class="lead-action" href="${esc(maps)}" target="_blank" rel="noreferrer" title="Ver no mapa" aria-label="Ver ${esc(title)} no mapa">${icon("map")}</a>`
      : "",
  ].join("");
  return `<article class="lead-card">
    <div class="lead-identity"><span class="lead-logo">${esc(initial)}</span><div class="lead-info"><h3>${esc(title)}</h3><span class="lead-category">${esc(category)}</span>${ratingHTML}</div></div>
    <div class="lead-contact">
      <div class="contact-line">${icon("pin")}<span title="${esc(address)}">${esc(address)}</span></div>
      ${phone ? `<div class="contact-line">${icon("phone")}<a href="${esc(phoneLink(phone) || "#")}">${esc(phone)}</a></div>` : ""}
      ${website ? `<div class="contact-line">${icon("globe")}<a href="${esc(website)}" target="_blank" rel="noreferrer">${esc(websiteLabel(website))}</a></div>` : ""}
      ${instagram ? `<div class="contact-line instagram-line">${icon("instagram")}<a href="${esc(instagram)}" target="_blank" rel="noreferrer">${esc(instagramLabel(instagram))}</a></div>` : ""}
      ${email ? `<div class="contact-line">${icon("mail")}<a href="mailto:${esc(email)}">${esc(email)}</a></div>` : ""}
    </div>
    <div class="lead-actions">${actions || '<span class="status-pill">Sem links</span>'}</div>
    ${details.length ? `<details class="lead-details"><summary>Ver mais informações</summary><div class="detail-data-grid">${details.map((entry) => `<div class="detail-data-item"><span>${esc(entry.label)}</span><strong>${esc(entry.value)}</strong></div>`).join("")}</div></details>` : ""}
  </article>`;
}

function bindResultControls() {
  $("#load-results")?.addEventListener("click", () => {
    resultPage = 0;
    loadResults();
  });
  $("#clear-results")?.addEventListener("click", () => {
    ["#result-search", "#result-category", "#result-rating"].forEach(
      (selector) => {
        if ($(selector)) $(selector).value = "";
      },
    );
    [
      "#result-phone",
      "#result-website",
      "#result-instagram",
      "#result-email",
    ].forEach((selector) => {
      if ($(selector)) $(selector).checked = false;
    });
    resultPage = 0;
    loadResults();
  });
  $("#download-filtered")?.addEventListener("click", downloadFiltered);
  $("#result-prev")?.addEventListener("click", () => {
    if (resultPage > 0) {
      resultPage -= 1;
      loadResults();
    }
  });
  $("#result-next")?.addEventListener("click", () => {
    resultPage += 1;
    loadResults();
  });
  $("#result-search")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      resultPage = 0;
      loadResults();
    }
  });
}

async function loadResults() {
  const container = $("#results");
  if (!container || !selectedJob) return;
  container.innerHTML =
    '<div class="lead-list"><div class="lead-card skeleton"></div><div class="lead-card skeleton"></div><div class="lead-card skeleton"></div></div>';
  try {
    const data = await api(
      `/api/v1/jobs/${selectedJob}/results?${resultFilters(true)}`,
    );
    if (!data.rows?.length) {
      container.innerHTML = `<div class="no-results"><div><h3>Nenhum resultado encontrado</h3><p>${data.total ? "Ajuste os filtros para visualizar outros contatos." : "Esta busca ainda não encontrou empresas."}</p></div></div>`;
    } else {
      container.innerHTML = `<div class="lead-list">${data.rows.map((row) => renderLeadCard(resultObject(data.header, row))).join("")}</div>`;
    }
    const pages = Math.ceil(Number(data.total || 0) / resultPageSize);
    $("#result-page").textContent =
      `${number(data.total)} ${Number(data.total) === 1 ? "empresa" : "empresas"} · Página ${resultPage + 1} de ${Math.max(1, pages)}`;
    $("#result-prev").disabled = resultPage === 0;
    $("#result-next").disabled = resultPage + 1 >= pages;
    $("#result-pager").classList.toggle("hidden", pages <= 1);
    $("#filtered-count").textContent =
      `${number(data.total)} ${Number(data.total) === 1 ? "resultado" : "resultados"}`;
  } catch (error) {
    container.innerHTML = `<div class="no-results"><div><h3>Não foi possível carregar os resultados</h3><p>${esc(error.message)}</p></div></div>`;
  }
}

async function downloadFiltered() {
  const button = $("#download-filtered");
  setButtonLoading(button, true);
  try {
    const body = {};
    for (const [key, value] of resultFilters(false).entries())
      body[key] =
        key === "min_rating" ? Number(value) : value === "true" ? true : value;
    const result = await api(`/api/v1/jobs/${selectedJob}/exports`, {
      method: "POST",
      body,
    });
    const link = document.createElement("a");
    link.href = `/api/v1/jobs/${selectedJob}/exports/${result.id}/download`;
    link.download = "";
    document.body.append(link);
    link.click();
    link.remove();
    toast(`${number(result.row_count)} resultados filtrados foram preparados.`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setButtonLoading(button, false);
  }
}

function statsCards(job, stats) {
  const values = [
    {
      icon: "building",
      value: stats?.total ?? job.results_count,
      label: "Empresas encontradas",
      tone: "",
    },
    {
      icon: "phone",
      value: stats?.with_phone ?? 0,
      label: "Com telefone",
      tone: "green",
    },
    {
      icon: "globe",
      value: stats?.with_website ?? 0,
      label: "Com site",
      tone: "green",
    },
    {
      icon: "instagram",
      value: stats?.with_instagram ?? 0,
      label: "Com Instagram",
      tone: "instagram",
    },
    {
      icon: "mail",
      value: stats?.with_email ?? 0,
      label: "Com e-mail",
      tone: "orange",
    },
  ];
  return `<div class="metric-grid result-metrics">${values.map((card) => `<div class="metric-card"><span class="metric-icon ${card.tone}">${icon(card.icon)}</span><span class="metric-copy"><strong>${number(card.value)}</strong><span>${card.label}</span></span></div>`).join("")}</div>`;
}

function errorMessage(job) {
  if (!job.error_message) return "";
  const translated = translateError(job.error_message);
  const message =
    translated === job.error_message
      ? "Ocorreu uma falha durante a coleta dos dados."
      : translated;
  return `<div class="error-banner">${icon("alert")}<div><strong>A busca não terminou como esperado</strong><p>${esc(message)} Você pode executá-la novamente.</p></div></div>`;
}

function progressDetails(job) {
  if (job.status === "queued") {
    return {
      percent: 4,
      label: "Preparando a busca…",
      detail: "Na fila local",
    };
  }
  const total = Number(job.progress_total || 0);
  const current = Number(job.progress_current || 0);
  const actual = total > 0 ? Math.round((current / total) * 100) : 0;
  const started = new Date(
    job.claimed_at || job.updated_at || job.created_at || Date.now(),
  ).getTime();
  const elapsedSeconds = Math.max(0, (Date.now() - started) / 1000);
  const terms = Math.max(1, job.data?.keywords?.length || 1);
  const depth = Math.max(10, Number(job.data?.depth || 25));
  const expectedSeconds = Math.max(70, terms * depth * 2.4);
  const estimated = Math.round(
    8 + 84 * (1 - Math.exp(-elapsedSeconds / expectedSeconds)),
  );
  const percent = Math.min(94, Math.max(8, actual, estimated));
  let label = "Coletando empresas e contatos…";
  if (percent >= 72) label = "Organizando os resultados encontrados…";
  else if (percent < 24) label = "Abrindo a região e iniciando a coleta…";
  const detail =
    current > 0 && total > 0
      ? `${current} de ${total} etapas`
      : "Progresso estimado";
  return { percent, label, detail };
}

function renderJobDetail(job, stats) {
  const status = statusInfo[job.status] || {
    label: job.status,
    short: job.status,
  };
  const hasResults = Number(job.results_count) > 0 || job.partial_results;
  const active = ["queued", "running"].includes(job.status);
  const terminal = [
    "failed",
    "timed_out",
    "canceled",
    "interrupted",
    "worker_lost",
    "succeeded",
  ].includes(job.status);
  const progress = progressDetails(job);
  const location = job.data?.location || "Local não registrado";
  const keywords = (job.data?.keywords || []).join(", ");
  $("#job-detail").innerHTML = `
    <button type="button" class="back-link detail-back" data-view="dashboard">← Minhas buscas</button>
    <header class="detail-header">
      <div class="detail-title"><span class="status-pill ${esc(job.status)}">${esc(status.label)}</span><h1>${esc(job.name)}</h1><p>${icon("pin")} ${esc(location)} · ${esc(keywords)}</p></div>
      <div class="detail-actions">
        ${hasResults ? `<a class="button button-primary download-main" href="/api/v1/jobs/${esc(job.id)}/download">${icon("download")} Baixar tudo em CSV</a>` : ""}
        ${active ? '<button id="cancel-job" class="button button-secondary" type="button">Cancelar busca</button>' : ""}
        <details class="more-menu"><summary aria-label="Mais ações" title="Mais ações">${icon("dots")}</summary><div class="more-popover">${terminal ? '<button id="retry-job" type="button">Executar novamente</button>' : ""}<button id="clone-job" type="button">Duplicar busca</button><button id="delete-job" class="danger-text" type="button">Excluir busca</button></div></details>
      </div>
      ${active ? `<div class="progress-panel"><div class="progress-heading"><span>${progress.label}</span><span>${progress.percent}%</span></div><div class="progress-track"><span style="width:${progress.percent}%"></span></div><small>${progress.detail}. Você pode continuar usando o computador normalmente.</small></div>` : ""}
    </header>
    ${errorMessage(job)}
    ${statsCards(job, stats)}
    <section class="content-card results-card" aria-labelledby="results-title">
      <div class="results-toolbar"><div><span class="section-kicker">Contatos encontrados</span><h2 id="results-title">Resultados</h2><p id="filtered-count">${hasResults ? "Carregando resultados…" : active ? "A busca está sendo executada." : "Nenhum resultado disponível."}</p></div>${hasResults ? `<a class="button button-secondary" href="/api/v1/jobs/${esc(job.id)}/download">${icon("download")} Baixar tudo</a>` : ""}</div>
      ${
        hasResults
          ? `<details class="filter-panel"><summary>${icon("filter")} Filtrar resultados <span>Busca, categoria e contatos</span></summary><div class="filters-grid">
        <input id="result-search" placeholder="Buscar nome, endereço ou contato" aria-label="Buscar nos resultados">
        <input id="result-category" placeholder="Categoria" aria-label="Filtrar por categoria">
        <input id="result-rating" type="number" min="0" max="5" step="0.1" placeholder="Nota mínima" aria-label="Nota mínima">
        <div class="filter-checks"><label><input id="result-phone" type="checkbox"> Com telefone</label><label><input id="result-website" type="checkbox"> Com site</label><label><input id="result-instagram" type="checkbox"> Com Instagram</label><label><input id="result-email" type="checkbox"> Com e-mail</label><div class="filter-actions"><button id="clear-results" class="filter-clear" type="button">Limpar</button><button id="download-filtered" class="button button-secondary" type="button">${icon("download")} Baixar filtrados</button><button id="load-results" class="filter-apply" type="button">Aplicar filtros</button></div></div>
      </div></details>`
          : ""
      }
      <div id="results">${hasResults ? "" : `<div class="no-results"><div><h3>${active ? "Aguarde só mais um pouco" : "Nenhuma empresa encontrada"}</h3><p>${active ? "Os resultados aparecerão aqui automaticamente." : "Tente executar novamente com outro termo ou uma distância maior."}</p></div></div>`}</div>
      ${hasResults ? '<div id="result-pager" class="pagination hidden"><button id="result-prev" type="button">← Anterior</button><span id="result-page"></span><button id="result-next" type="button">Próxima →</button></div>' : ""}
    </section>`;
  $$("[data-view]", $("#job-detail")).forEach(
    (button) => (button.onclick = () => view(button.dataset.view)),
  );
  $("#cancel-job")?.addEventListener("click", () => actionJob("cancel"));
  $("#retry-job")?.addEventListener("click", () => actionJob("retry"));
  $("#clone-job")?.addEventListener("click", () => actionJob("clone"));
  $("#delete-job")?.addEventListener("click", deleteJob);
  bindResultControls();
  if (hasResults) loadResults();
}

async function openJob(id, { silent = false } = {}) {
  const requestID = ++detailRequest;
  selectedJob = id;
  resultPage = silent ? resultPage : 0;
  if (!silent) {
    view("detail");
    $("#job-detail").innerHTML =
      '<div class="content-card results-card"><div class="lead-list"><div class="lead-card skeleton"></div><div class="lead-card skeleton"></div><div class="lead-card skeleton"></div></div></div>';
  }
  try {
    const job = await api(`/api/v1/jobs/${id}`);
    if (requestID !== detailRequest || selectedJob !== id) return;
    selectedJobActive = ["queued", "running"].includes(job.status);
    let stats = null;
    if (Number(job.results_count) > 0 || job.partial_results) {
      try {
        stats = await api(`/api/v1/jobs/${id}/stats`);
      } catch {
        stats = null;
      }
    }
    if (requestID !== detailRequest || selectedJob !== id) return;
    renderJobDetail(job, stats);
  } catch (error) {
    if (!silent) {
      $("#job-detail").innerHTML =
        `<div class="empty-state"><div class="empty-state-content"><span class="empty-icon">${icon("alert")}</span><h3>Não foi possível abrir esta busca</h3><p>${esc(error.message)}</p><button class="button button-secondary" type="button" data-view="dashboard">Voltar</button></div></div>`;
      $('[data-view="dashboard"]', $("#job-detail"))?.addEventListener(
        "click",
        () => view("dashboard"),
      );
    }
  }
}

async function actionJob(action) {
  const labels = {
    cancel: "Cancelamento solicitado.",
    clone: "A busca foi duplicada.",
    retry: "A busca foi reiniciada.",
  };
  try {
    const result = await api(`/api/v1/jobs/${selectedJob}/${action}`, {
      method: "POST",
    });
    toast(labels[action] || "Ação concluída.");
    await openJob(result.id || selectedJob);
  } catch (error) {
    toast(error.message, "error");
  }
}

function deleteJob() {
  const dialog = $("#confirm-dialog");
  dialog.showModal();
  dialog.onclose = async () => {
    if (dialog.returnValue !== "confirm") return;
    try {
      await api(`/api/v1/jobs/${selectedJob}`, { method: "DELETE" });
      toast("Busca excluída.");
      selectedJob = null;
      selectedJobActive = false;
      view("dashboard");
    } catch (error) {
      toast(error.message, "error");
    }
  };
}

async function loadTemplates() {
  try {
    const data = await api("/api/v1/templates");
    templates = data.items || [];
    $("#template-select").innerHTML =
      '<option value="">Nenhuma</option>' +
      templates
        .map(
          (item) =>
            `<option value="${esc(item.id)}">${esc(item.name)}</option>`,
        )
        .join("");
  } catch {
    templates = [];
  }
}

function fillForm(template) {
  const form = $("#job-form").elements;
  const data = template.data || {};
  form.keywords.value = (data.keywords || []).join("\n");
  form.name.value = template.name || "";
  form.depth.value = String(data.depth || 25);
  form.radius.value = String(data.radius || 10000);
  form.email.checked = Boolean(data.email);
  form.extra_reviews.checked = Boolean(data.extra_reviews);
  form.location.value = data.location || "";
  form.lat.value = data.lat || "";
  form.lon.value = data.lon || "";
  if (form.lat.value && form.lon.value) {
    manualLocationMode = false;
    const title = data.location || "Local da configuração salva";
    $("#location-selected").innerHTML =
      `${icon("check")}<span>Local confirmado: ${esc(title)}</span>`;
    $("#location-selected").classList.remove("hidden");
  } else if (form.location.value && data.fast_mode === false) {
    selectTextLocation();
  } else {
    clearSelectedLocation();
  }
  updateFormSummary();
  toast("Configuração aplicada.");
}

$$("[data-view]").forEach((button) =>
  button.addEventListener("click", () => view(button.dataset.view)),
);
$("#theme-toggle").addEventListener("click", () => {
  const next =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next, true);
});
$("#refresh").onclick = loadJobs;
$("#status-filter").onchange = () => {
  campaignPage = 0;
  loadJobs();
};
$("#prev-page").onclick = () => {
  if (campaignPage > 0) {
    campaignPage -= 1;
    loadJobs();
  }
};
$("#next-page").onclick = () => {
  campaignPage += 1;
  loadJobs();
};
$("#keywords").addEventListener("input", updateFormSummary);
$("#location").addEventListener("input", queueLocationSearch);
$("#location").addEventListener("focus", () => {
  if (
    $("#location-results").children.length &&
    !$("#job-form").elements.lat.value
  )
    $("#location-results").classList.remove("hidden");
});
$("#job-form").elements.radius.addEventListener("change", updateFormSummary);
$("#job-form").elements.depth.addEventListener("change", updateFormSummary);
$("#load-template").onclick = () => {
  const template = templates.find(
    (item) => item.id === $("#template-select").value,
  );
  if (template) fillForm(template);
  else toast("Escolha uma configuração salva.", "error");
};
document.addEventListener("click", (event) => {
  if (!event.target.closest(".form-block-content"))
    $("#location-results").classList.add("hidden");
});
$("#job-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!(await validateSearchForm())) return;
  const buttons = [$("#create-job"), $("#create-job-mobile")];
  buttons.forEach((button) => setButtonLoading(button, true));
  try {
    const job = await api("/api/v1/jobs", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: formPayload(),
    });
    toast("Busca iniciada. Os resultados aparecerão automaticamente.");
    await openJob(job.id);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    buttons.forEach((button) => setButtonLoading(button, false));
  }
};

updateFormSummary();
loadJobs();

setInterval(() => {
  if (!$("#dashboard").classList.contains("hidden")) loadJobs();
  if (
    !$("#detail").classList.contains("hidden") &&
    selectedJob &&
    selectedJobActive
  )
    openJob(selectedJob, { silent: true });
}, 5000);
