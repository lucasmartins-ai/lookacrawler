import { processHtmlToMarkdown } from "./extractor.js";

/**
 * Benchmark token & byte reduction of LookaCrawler HTML-to-Markdown optimization pipeline
 */
function runBenchmark() {
  const sampleVerboseHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Complex Web Article - Performance Test</title>
      <style>
        body { font-family: sans-serif; margin: 0; padding: 0; color: #333; background-color: #f4f4f9; }
        header { background: #0073aa; color: white; padding: 1rem; text-align: center; }
        nav { display: flex; justify-content: center; background: #333; }
        nav a { color: white; padding: 14px 20px; text-decoration: none; text-align: center; }
        nav a:hover { background-color: #ddd; color: black; }
        .sidebar { float: right; width: 30%; background: #e0e0e0; padding: 15px; }
        .content { float: left; width: 65%; padding: 15px; }
        footer { background: #333; color: white; text-align: center; padding: 10px; position: fixed; bottom: 0; width: 100%; }
        @media (max-width: 600px) { .sidebar, .content { width: 100%; float: none; } }
      </style>
      <script>
        console.log("Analytics initialized...");
        window.tracking = { user: "12345", session: "abcdef" };
        function sendEvent(evt) { fetch("/api/log", { method: "POST", body: JSON.stringify(evt) }); }
        document.addEventListener("DOMContentLoaded", function() { sendEvent({ type: "pageview" }); });
      </script>
    </head>
    <body>
      <header>
        <h1>Developer Daily Portal</h1>
        <p>The latest updates in Web Development, AI, and Software Architecture</p>
      </header>
      <nav>
        <a href="#news">News</a>
        <a href="#tutorials">Tutorials</a>
        <a href="#architecture">Architecture</a>
        <a href="#contact">Contact Us</a>
      </nav>

      <div class="content">
        <article>
          <h1>Understanding Model Context Protocol (MCP) in 2026</h1>
          <p class="author">By Alex Rivera | Published on August 5, 2026</p>
          
          <p>Model Context Protocol (MCP) has revolutionized how large language models interact with external data sources. By standardizing tools, resources, and prompt templates, MCP enables AI agents to seamlessly inspect local file systems, query databases, and trigger specialized workflows safely.</p>

          <h2>Key Architecture Principles</h2>
          <p>At its core, MCP operates over a standard transport layer such as standard I/O (stdio) or WebSockets/SSE. Servers expose registered tools with strict Zod schemas, ensuring that LLMs generate well-formed arguments before execution.</p>

          <ul>
            <li><strong>Decoupled Architecture:</strong> Clients and servers remain independent.</li>
            <li><strong>Security Controls:</strong> Explicit user approval for destructive commands.</li>
            <li><strong>Context Efficiency:</strong> Content extraction tools compress raw HTML into token-optimized Markdown.</li>
          </ul>

          <h2>Conclusion</h2>
          <p>As context window limits continue to expand, optimizing token density remains crucial for latency and cost reduction. Tools like LookaCrawler ensure LLMs receive clean, actionable information without background noise.</p>
        </article>
      </div>

      <div class="sidebar">
        <h3>Trending Topics</h3>
        <ul>
          <li><a href="#">TypeScript 7.0 Features</a></li>
          <li><a href="#">Bun 1.3 Optimization Tips</a></li>
          <li><a href="#">AI Agents in Enterprise Workflows</a></li>
        </ul>
        <form action="/newsletter" method="post">
          <h4>Subscribe to Newsletter</h4>
          <input type="email" placeholder="Enter your email" />
          <button type="submit">Subscribe</button>
        </form>
        <svg height="100" width="100">
          <circle cx="50" cy="50" r="40" stroke="black" stroke-width="3" fill="red" />
        </svg>
      </div>

      <footer>
        <p>&copy; 2026 Developer Daily Portal. All rights reserved. <a href="/privacy">Privacy Policy</a> | <a href="/terms">Terms of Service</a></p>
      </footer>
    </body>
    </html>
  `;

  const rawBytes = Buffer.byteLength(sampleVerboseHtml, "utf-8");
  const rawApproxTokens = Math.ceil(sampleVerboseHtml.length / 4);

  const markdownResult = processHtmlToMarkdown(sampleVerboseHtml, {
    url: "https://example.com/benchmark-article",
  });

  const markdownBytes = Buffer.byteLength(markdownResult, "utf-8");
  const markdownApproxTokens = Math.ceil(markdownResult.length / 4);

  const byteReductionPercentage = (((rawBytes - markdownBytes) / rawBytes) * 100).toFixed(2);
  const tokenReductionPercentage = (((rawApproxTokens - markdownApproxTokens) / rawApproxTokens) * 100).toFixed(2);

  console.log("=== LookaCrawler Token Optimization Benchmark ===");
  console.log(`Raw HTML Size:           ${rawBytes} bytes (~${rawApproxTokens} tokens)`);
  console.log(`Extracted Markdown Size: ${markdownBytes} bytes (~${markdownApproxTokens} tokens)`);
  console.log(`Byte Reduction:          ${byteReductionPercentage}%`);
  console.log(`Token Reduction:         ${tokenReductionPercentage}%`);
  console.log("------------------------------------------------");
  console.log("Extracted Markdown Preview:");
  console.log(markdownResult.slice(0, 300) + "...\n");

  if (Number(tokenReductionPercentage) >= 70) {
    console.log("✅ BENCHMARK SUCCESS: Token reduction exceeds target threshold of 70%!");
  } else {
    console.log(`⚠️ Benchmark metric: ${tokenReductionPercentage}% reduction achieved.`);
  }
}

runBenchmark();
