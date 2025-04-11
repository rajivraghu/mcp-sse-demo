import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getProducts, getInventory, getOrders, createPurchase } from "./services/inventory-service.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const server = new McpServer({
  name: "mcp-sse-demo",
  version: "1.0.0",
  description: "提供商品查询、库存管理和订单处理的MCP工具"
});

// 获取产品列表工具
server.tool(
  "getProducts",
  "获取所有产品信息",
  {},
  async () => {
    console.log("获取产品列表");
    const products = await getProducts();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(products)
        }
      ]
    };
  }
);

// 获取库存信息工具
server.tool(
  "getInventory",
  "获取所有产品的库存信息",
  {},
  async () => {
    console.log("获取库存信息");
    const inventory = await getInventory();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(inventory)
        }
      ]
    };
  }
);

// 获取订单列表工具
server.tool(
  "getOrders",
  "获取所有订单信息",
  {},
  async () => {
    console.log("获取订单列表");
    const orders = await getOrders();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(orders)
        }
      ]
    };
  }
);

// 购买商品工具
server.tool(
  "purchase",
  "购买商品",
  {
    items: z
      .array(
        z.object({
          productId: z.number().describe("商品ID"),
          quantity: z.number().describe("购买数量")
        })
      )
      .describe("要购买的商品列表"),
    customerName: z.string().describe("客户姓名")
  },
  async ({ items, customerName }) => {
    console.log("处理购买请求", { items, customerName });

    try {
      const order = await createPurchase(customerName, items);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(order)
          }
        ]
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: error.message })
          }
        ]
      };
    }
  }
);

server.resource(
  "orderFAQs",
  new ResourceTemplate("orderfaq://{section?}", { 
    list: async () => ({
      resources: [
        {
          name: "Order FAQs",
          uri: "orderfaq://all",
          description: "Any Order support, escalations, or other questions",
        }
      ]
    })
  }),
  async (uri, params) => {
    try {
      const faqPath = path.join(__dirname, 'data', 'ordersfaq.txt');
      const faqContent = await fs.readFile(faqPath, 'utf8');

      // Always return the full content regardless of section parameter
      return {
        contents: [{
          uri: uri.href,
          text: faqContent
        }]
      };
    } catch (error) {
      console.error("Error reading FAQ file:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        contents: [{
          uri: uri.href,
          text: `Error retrieving FAQs: ${errorMessage}`
        }]
      };
    }
  }
);
