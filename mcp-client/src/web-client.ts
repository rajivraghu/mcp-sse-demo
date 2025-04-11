/**
 * This is a web client example for integrating the MCP client in a Node.js server.
 * In a real-world project, this code can be integrated into Next.js, Express, or other web frameworks.
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { config } from "./config.js";
import { createAnthropicClient } from "./utils.js";
import { Anthropic } from "@anthropic-ai/sdk";

// Get the current file's directory path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mcpClient: McpClient | null = null;
let anthropicTools: any[] = [];
let availableResources: any[] = []; // ✅ as updated!!
let aiClient: Anthropic;

const app = express();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ✅ as updated!!
function generateSystemPromptFromResources(resources: any[]): string {
  return `You have access to the following resources:\n` + resources.map((r) => {
    return `- ${r.name || "Unnamed"}: ${r.description || "No description"}`;
  }).join("\n");
}

// Initialize MCP client
async function initMcpClient() {
  if (mcpClient) return;

  try {
    console.log("Connecting to MCP server...");
    mcpClient = new McpClient({
      name: "mcp-client",
      version: "1.0.0",
    });

    const transport = new SSEClientTransport(new URL(config.mcp.serverUrl));
    await mcpClient.connect(transport);

    const { tools } = await mcpClient.listTools();
   
    const resourceResponse = await mcpClient.listResources(); // ✅ changed
    availableResources = resourceResponse.resources || []; // ✅ changed

    console.log("MCP client connected successfully");
    console.log("Available tools:", tools);
    console.log("Available resources:", availableResources);

    anthropicTools = tools.map((tool: any) => {
      return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      };
    });

    aiClient = createAnthropicClient(config);

    console.log("MCP client and tools initialized successfully");
  } catch (error) {
    console.error("Failed to initialize MCP client:", error);
    throw error;
  }
}

// Homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// Create API router
const apiRouter = express.Router();

// Middleware: ensure MCP client is initialized
// @ts-ignore
apiRouter.use((req, res, next) => {
  if (!mcpClient) {
    initMcpClient().catch(console.error);
  }
  next();
});

// API: Get available tools
// @ts-ignore
apiRouter.get("/tools", async (req, res) => {
  try {
    res.json({ tools: anthropicTools });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// API: Chat request
// @ts-ignore
apiRouter.post("/chat", async (req, res) => {
  try {
    console.log("Received chat requestzzzzzzz");
    const { message, history = [] } = req.body;
    console.log(`User message: ${message}`);
    console.log(`History message count: ${history.length}`);

    if (!message) {
      console.warn("Message is empty in the request");
      return res.status(400).json({ error: "Message cannot be empty" });
    }

    const systemPrompt = generateSystemPromptFromResources(availableResources); // ✅ as updated!!
    const messages = [
        ...history,
      { role: "user", content: message },
    ]; // ✅ as updated!!

    console.log("Preparing to call AI model");
    //console.log("System prompt:", systemPrompt);
    // console.log("User message:", message);
    // console.log("History messages:", history);
    // console.log(`Total messages to send to AI: ${messages.length}`);
    // console.log(`Calling AI model: ${config.ai.defaultModel}`);

    const response = await aiClient.messages.create({
      model: config.ai.defaultModel,
      system: 'Your Name is Rajiv BOT you have access to available resources at  uri: orderfaq://all for any escalations related info.For the given user question, if you decide to use a resource, then in the ouput just say ###resource:resource_url Ex:###resource:orderfaq://all', 
      messages,
      tools: anthropicTools,
      max_tokens: 1000,
    });
    console.log("AI responded successfully"+JSON.stringify(response.content));

    const hasToolUse = response.content.some(
      (item) => item.type === "tool_use"
    );

    if (hasToolUse) {
      const toolResults = [];

      for (const content of response.content) {
        if (content.type === "tool_use") {
          const name = content.name;
          const toolInput = content.input as { [x: string]: unknown } | undefined;

          try {
            if (!mcpClient) {
              console.error("MCP client is not initialized");
              throw new Error("MCP client is not initialized");
            }
            console.log(`Calling MCP tool: ${name}`);
            const toolResult = await mcpClient.callTool({
              name,
              arguments: toolInput,
            });
            console.log(`Tool result: ${JSON.stringify(toolResult)}`);

            toolResults.push({
              name,
              result: toolResult,
            });
          } catch (error: any) {
            console.error(`Tool call failed: ${name}`, error);
            toolResults.push({
              name,
              error: error.message,
            });
          }
        }
      }

      // Final AI response after tool calls
      console.log("Requesting final AI response");
      const finalResponse = await aiClient.messages.create({
        model: config.ai.defaultModel,
        messages: [
         // { role: "system", content: systemPrompt }, // ✅ as updated!!
          ...history,
          { role: "user", content: message },
          {
            role: "user",
            content: JSON.stringify(toolResults),
          },
        ], // ✅ as updated!!
        max_tokens: 1000,
      });
      console.log("Final AI response received");

      const textResponse = finalResponse.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      res.json({
        response: textResponse,
        toolCalls: toolResults,
      });
    } else {
      const textResponse = response.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      res.json({
        response: textResponse,
        toolCalls: [],
      });
    }
  } catch (error: any) {
    console.error("Failed to handle chat request:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Direct tool call
// @ts-ignore
apiRouter.post("/call-tool", async (req, res) => {
  try {
    const { name, args } = req.body;

    if (!name) {
      console.warn("Tool name is missing in the request");
      return res.status(400).json({ error: "Tool name cannot be empty" });
    }

    if (!mcpClient) {
      console.error("MCP client is not initialized");
      throw new Error("MCP client is not initialized");
    }

    const result = await mcpClient.callTool({
      name,
      arguments: args || {},
    });
    res.json({ result });
  } catch (error: any) {
    console.error("Failed to handle tool call request:", error);
    res.status(500).json({ error: error.message });
  }
});

// Register API router
app.use("/api", apiRouter);

// Start the server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Web client server is running at: http://localhost:${PORT}`);

  // Pre-initialize MCP client
  initMcpClient().catch(console.error);
});
