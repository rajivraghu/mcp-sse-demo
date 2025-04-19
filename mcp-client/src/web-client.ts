/*
 * Full fixed version of the web client for MCP + Anthropic
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { config } from "./config.js";
import { Anthropic } from "@anthropic-ai/sdk";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mcpClient: McpClient | null = null;
let anthropicTools: any[] = [];

const aiClient = new Anthropic({
  apiKey: process.env["ANTHROPIC_API_KEY"],
});


const SYSTEM_PROMPT = `You are a strict assistant that only answers using available tools and explicitly provided resources.

Available resource:
- URI: orderfaq://all
- Name: Order FAQs
- Description: Contains FAQs, escalations, and other order-related questions.

Rules:
1. You may only use the above resource to answer user queries. If it is relevant and used, include:
   <resource_use="true"/><resource uri="orderfaq://all"/>
   If not used, omit the tag.
2. Do NOT ask for user information (e.g., name, order number, email) unless a tool or resource explicitly supports querying by that information.
3. Do NOT fabricate actions or pretend to perform tool usage if the functionality does not exist.
4. If no relevant tool or resource is available to answer the question, respond exactly with:
   "I am unable to assist with the user query."
5. Do not generate any assumptions or general knowledge. Only respond when a specific resource or tool provides the answer.

You must follow these rules without exception.`;



async function initMcpClient() {
  if (mcpClient) return;
  console.log("Connecting to MCP server …");
  mcpClient = new McpClient({ name: "mcp-client", version: "1.0.0" });
  await mcpClient.connect(new SSEClientTransport(new URL(config.mcp.serverUrl)));
  const { tools } = await mcpClient.listTools();
  const resources = await mcpClient.listResources();
  console.log("Available MCP tools:", JSON.stringify(tools));
  console.log("Available MCP resources:", JSON.stringify(resources));
  anthropicTools = tools.map((t: any) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
  console.log("MCP client ready ✔\n");
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

app.get("/", (_, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

const apiRouter = express.Router();
apiRouter.use(async (_req, _res, next) => {
  try {
    await initMcpClient();
    next();
  } catch (err) {
    next(err);
  }
});

apiRouter.get("/tools", (_req, res) => res.json({ tools: anthropicTools }));

apiRouter.post("/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: "消息不能为空" });

    const firstResponse = await aiClient.messages.create({
      model: "claude-3-7-sonnet-20250219",
      system: SYSTEM_PROMPT,
      max_tokens: 1000,
      messages: [...history, { role: "user", content: message }],
      tools: anthropicTools,
    });

    console.log("Sending first request to Claude:\n", JSON.stringify({
      model: "claude-3-7-sonnet-20250219",
      system: SYSTEM_PROMPT,
      max_tokens: 1000,
      messages: [...history, { role: "user", content: message }],
      tools: anthropicTools,
    }, null, 2));

    const textSegment = firstResponse.content.find((c) => c.type === "text");
    const assistantText = textSegment && "text" in textSegment ? textSegment.text : "";
    const usesResource = assistantText.includes('<resource_use="true"/>');
    const uriMatch = assistantText.match(/<resource uri="([^"]+)"\/>/);
    const resourceUri = uriMatch?.[1] ?? null;
    const containsToolCall = firstResponse.content.some((c) => c.type === "tool_use");

    if (usesResource && resourceUri) {
      const resourceContent = await mcpClient!.readResource({ uri: resourceUri });
      const resourcePrompt = [
        ...history,
        { role: "user", content: message },
        {
          role: "assistant",
          content: `Here is the resource (URI: ${resourceUri}):\n${JSON.stringify(resourceContent, null, 2)}`,
        },
        {
          role: "user",
          content: "Using the information above, answer my original question as fully and helpfully as possible.",
        },
      ];

      const secondResponse = await aiClient.messages.create({
        model: "claude-3-7-sonnet-20250219",
        system: SYSTEM_PROMPT,
        max_tokens: 1000,
        messages: resourcePrompt,
      });

      console.log("Sending second request to Claude with resource context:\n", JSON.stringify({
        model: "claude-3-7-sonnet-20250219",
        system: SYSTEM_PROMPT,
        max_tokens: 1000,
        messages: resourcePrompt,
      }, null, 2));

      const finalText = secondResponse.content
        .filter((c) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");

      return res.json({ response: finalText, resource: resourceContent });
    }

    if (containsToolCall) {
      const toolResults: any[] = [];

      for (const segment of firstResponse.content) {
        if (segment.type !== "tool_use") continue;
        const { name, input: toolArgs } = segment as any;
        try {
          const result = await mcpClient!.callTool({ name, arguments: toolArgs || {} });
          toolResults.push({ name, result });
        } catch (err: any) {
          toolResults.push({ name, error: err.message });
        }
      }

      const secondPass = await aiClient.messages.create({
        model: "claude-3-7-sonnet-20250219",
        system: SYSTEM_PROMPT,
        max_tokens: 1000,
        messages: [
          ...history,
          { role: "user", content: message },
          { role: "assistant", content: JSON.stringify(toolResults) },
        ],
      });

      console.log("Sending second request to Claude with tool results:\n", JSON.stringify({
        model: "claude-3-7-sonnet-20250219",
        system: SYSTEM_PROMPT,
        max_tokens: 1000,
        messages: [
          ...history,
          { role: "user", content: message },
          { role: "assistant", content: JSON.stringify(toolResults) },
        ],
      }, null, 2));

      const finalText = secondPass.content
        .filter((c) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");

      return res.json({ response: finalText, toolCalls: toolResults });
    }

    return res.json({ response: assistantText || "(No text response)", toolCalls: [] });
  } catch (err: any) {
    console.error("/chat handler error:", err);
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post("/call-tool", async (req, res) => {
  try {
    const { name, args = {} } = req.body;
    if (!name) return res.status(400).json({ error: "工具名称不能为空" });
    if (!mcpClient) throw new Error("MCP客户端未初始化");
    const result = await mcpClient.callTool({ name, arguments: args });
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.use("/api", apiRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Web client listening → http://localhost:${PORT}`);
  initMcpClient().catch(console.error);
});
