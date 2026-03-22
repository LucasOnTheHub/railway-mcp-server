#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

// --- Streamable HTTP transport (modern /mcp endpoint) ---
const streamableTransports: Record<string, StreamableHTTPServerTransport> = {};

app.all("/mcp", async (req, res) => {
	const sessionId = req.headers["mcp-session-id"] as string | undefined;

	if (sessionId && streamableTransports[sessionId]) {
		const transport = streamableTransports[sessionId];
		await transport.handleRequest(req, res, req.body);
		return;
	}

	if (req.method === "POST") {
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (id) => {
				streamableTransports[id] = transport;
			},
		});

		transport.onclose = () => {
			if (transport.sessionId) {
				delete streamableTransports[transport.sessionId];
			}
		};

		const server = createServer();
		await server.connect(transport);
		await transport.handleRequest(req, res, req.body);
		return;
	}

	res.status(400).send("Bad Request: No valid session ID provided");
});

// --- Legacy SSE transport ---
const sseTransports: Record<string, SSEServerTransport> = {};

app.get("/sse", async (req, res) => {
	const transport = new SSEServerTransport("/messages", res);
	const sessionId = transport.sessionId;
	sseTransports[sessionId] = transport;

	transport.onclose = () => {
		delete sseTransports[sessionId];
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

	const transport = sseTransports[sessionId];
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
	console.log(`Railway MCP server listening on port ${PORT}`);
});

process.on("SIGINT", async () => {
	for (const id in streamableTransports) {
		await streamableTransports[id].close();
		delete streamableTransports[id];
	}
	for (const id in sseTransports) {
		await sseTransports[id].close();
		delete sseTransports[id];
	}
	process.exit(0);
});
