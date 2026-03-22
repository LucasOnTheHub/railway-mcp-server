#!/usr/bin/env node
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import * as tools from "./tools";
import { getVersion } from "./utils";

const createServer = () => {
	const server = new McpServer(
		{
			name: "railway-mcp-server",
			title: "Railway MCP Server",
			version: getVersion(),
		},
		{
			capabilities: {
				logging: {},
			},
		},
	);

	for (const tool of Object.values(tools)) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
			},
			tool.handler,
		);
	}

	return server;
};

const app = express();
app.use(express.json());

const transports: Record<string, SSEServerTransport> = {};

app.get("/sse", async (req, res) => {
	const transport = new SSEServerTransport("/messages", res);
	const sessionId = transport.sessionId;
	transports[sessionId] = transport;

	transport.onclose = () => {
		delete transports[sessionId];
	};

	const server = createServer();
	await server.connect(transport);
});

app.post("/messages", async (req, res) => {
	const sessionId = req.query.sessionId as string;
	if (!sessionId) {
		res.status(400).send("Missing sessionId parameter");
		return;
	}

	const transport = transports[sessionId];
	if (!transport) {
		res.status(404).send("Session not found");
		return;
	}

	await transport.handlePostMessage(req, res, req.body);
});

app.get("/health", (_req, res) => {
	res.json({ status: "ok" });
});

const PORT = Number.parseInt(process.env.PORT || "3000", 10);

app.listen(PORT, "0.0.0.0", () => {
	console.log(`Railway MCP SSE server listening on port ${PORT}`);
});

process.on("SIGINT", async () => {
	for (const sessionId in transports) {
		await transports[sessionId].close();
		delete transports[sessionId];
	}
	process.exit(0);
});
