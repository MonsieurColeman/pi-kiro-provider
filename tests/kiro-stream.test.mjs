import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const buildDir = process.env.PI_KIRO_PROVIDER_BUILD_DIR;
if (!buildDir) throw new Error("PI_KIRO_PROVIDER_BUILD_DIR is required.");

const fromBuild = (path) => pathToFileURL(join(buildDir, path)).href;
const { createKiroStream } = await import(fromBuild("src/kiro.js"));
const { crc32 } = await import(fromBuild("src/eventstream.js"));

const encoder = new TextEncoder();

function createLogger() {
  return { debug() {}, warn() {}, error() {} };
}

function createModel() {
  return {
    id: "kiro-test",
    name: "Kiro Test",
    api: "kiro",
    provider: "kiro",
    baseUrl: "https://kiro.example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  };
}

function encodeHeader(name, value) {
  const nameBytes = encoder.encode(name);
  const valueBytes = encoder.encode(value);
  const header = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  let offset = 0;
  header[offset] = nameBytes.length;
  offset += 1;
  header.set(nameBytes, offset);
  offset += nameBytes.length;
  header[offset] = 7;
  offset += 1;
  header[offset] = (valueBytes.length >>> 8) & 0xff;
  header[offset + 1] = valueBytes.length & 0xff;
  offset += 2;
  header.set(valueBytes, offset);
  return header;
}

function concatBytes(chunks) {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function createFrame(eventType, payload) {
  const headerBytes = encodeHeader(":event-type", eventType);
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const totalLength = 12 + headerBytes.length + payloadBytes.length + 4;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headerBytes.length, false);
  view.setUint32(8, crc32(frame.subarray(0, 8)), false);
  frame.set(headerBytes, 12);
  frame.set(payloadBytes, 12 + headerBytes.length);
  view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
  return frame;
}

function createResponse(events) {
  const body = concatBytes(events.map(([eventType, payload]) => createFrame(eventType, payload)));
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  }), { status: 200 });
}

test("Kiro toolUseEvent updates same-id tool calls with latest complete arguments", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => createResponse([
      ["toolUseEvent", { toolUseId: "tooluse_find", name: "find", input: {} }],
      ["toolUseEvent", { toolUseId: "tooluse_find", name: "find", input: { path: "src", pattern: "*.ts" } }],
      ["metricsEvent", { inputTokens: 1, outputTokens: 1 }],
    ]);

    const stream = createKiroStream({
      apiKey: "token",
      providerId: "kiro",
      upstreamUrl: "https://kiro.example.invalid/generate",
      requestTimeoutMs: 1_000,
      pricing: { usdPerCredit: 0.04 },
    }, {}, createLogger())(createModel(), {
      messages: [{ role: "user", content: "find TypeScript files" }],
      tools: [{ name: "find", description: "Find files", parameters: { type: "object" } }],
    });

    const events = [];
    for await (const event of stream) events.push(event);
    const toolStarts = events.filter((event) => event.type === "toolcall_start");
    const toolEnds = events.filter((event) => event.type === "toolcall_end");
    const message = await stream.result();

    assert.equal(toolStarts.length, 1);
    assert.equal(toolEnds.length, 1);
    assert.equal(message.stopReason, "toolUse");
    assert.deepEqual(toolEnds[0].toolCall, {
      type: "toolCall",
      id: "tooluse_find",
      name: "find",
      arguments: { path: "src", pattern: "*.ts" },
    });
    assert.deepEqual(message.content, [toolEnds[0].toolCall]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kiro fragmented same-id string inputs are accumulated before tool call end", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => createResponse([
      ["toolUseEvent", { toolUseId: "tooluse_grep", name: "grep", input: "{\"path\":" }],
      ["toolUseEvent", { toolUseId: "tooluse_grep", name: "grep", input: "\"src\",\"pattern\":\"toolUseEvent\"}" }],
    ]);

    const stream = createKiroStream({
      apiKey: "token",
      providerId: "kiro",
      upstreamUrl: "https://kiro.example.invalid/generate",
      requestTimeoutMs: 1_000,
      pricing: { usdPerCredit: 0.04 },
    }, {}, createLogger())(createModel(), {
      messages: [{ role: "user", content: "grep tool events" }],
      tools: [{ name: "grep", description: "Search files", parameters: { type: "object" } }],
    });

    const events = [];
    for await (const event of stream) events.push(event);
    const toolStarts = events.filter((event) => event.type === "toolcall_start");
    const toolEnds = events.filter((event) => event.type === "toolcall_end");

    assert.equal(toolStarts.length, 1);
    assert.equal(toolEnds.length, 1);
    assert.deepEqual(toolEnds[0].toolCall.arguments, { path: "src", pattern: "toolUseEvent" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function runMeteredStream(frames) {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => createResponse(frames);
    const stream = createKiroStream({
      apiKey: "token",
      providerId: "kiro",
      upstreamUrl: "https://kiro.example.invalid/generate",
      requestTimeoutMs: 1_000,
      pricing: { usdPerCredit: 0.04 },
    }, {}, createLogger())(createModel(), { messages: [{ role: "user", content: "hi" }] });
    for await (const _event of stream) { /* drain */ }
    return await stream.result();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("Kiro meteringEvent credits drive usage cost, split by token share", async () => {
  const message = await runMeteredStream([
    ["metricsEvent", { inputTokens: 100, outputTokens: 300 }],
    ["meteringEvent", { usage: 0.5, unit: "credit", unitPlural: "credits" }],
  ]);
  const { cost } = message.usage;
  assert.ok(Math.abs(cost.total - 0.02) < 1e-12);
  assert.ok(Math.abs(cost.input - 0.005) < 1e-12);
  assert.ok(Math.abs(cost.output - 0.015) < 1e-12);
});

test("Kiro stream without meteringEvent reports zero cost", async () => {
  const message = await runMeteredStream([["metricsEvent", { inputTokens: 100, outputTokens: 300 }]]);
  assert.equal(message.usage.cost.total, 0);
});

async function captureConversationState(messages) {
  const originalFetch = globalThis.fetch;
  let body;
  try {
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body);
      return createResponse([["metricsEvent", { inputTokens: 1, outputTokens: 1 }]]);
    };
    const stream = createKiroStream({
      apiKey: "token",
      providerId: "kiro",
      upstreamUrl: "https://kiro.example.invalid/generate",
      requestTimeoutMs: 1_000,
      pricing: { usdPerCredit: 0.04 },
    }, {}, createLogger())(createModel(), { messages });
    for await (const _event of stream) { /* drain */ }
    return body.conversationState;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const assistantText = (text) => ({ role: "assistant", content: [{ type: "text", text }], model: "kiro-test", timestamp: 1 });

test("Kiro trailing developer message after assistant stop becomes the current user turn", async () => {
  const state = await captureConversationState([
    { role: "user", content: "do it" },
    assistantText("done"),
    { role: "developer", content: [{ type: "text", text: "<system-reminder>keep going</system-reminder>" }] },
  ]);
  assert.equal(state.history.length, 2);
  assert.ok("assistantResponseMessage" in state.history[1]);
  assert.equal(state.currentMessage.userInputMessage.content, "<system-reminder>keep going</system-reminder>");
});

test("Kiro developer message after tool results merges into the pending user turn", async () => {
  const state = await captureConversationState([
    { role: "user", content: "run it" },
    { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "find", arguments: {} }], model: "kiro-test", timestamp: 1 },
    { role: "toolResult", toolCallId: "t1", toolName: "find", content: [{ type: "text", text: "ok" }], isError: false },
    { role: "developer", content: "note" },
  ]);
  assert.equal(state.history.length, 2);
  assert.ok("userInputMessage" in state.history[0]);
  assert.ok("assistantResponseMessage" in state.history[1]);
  const current = state.currentMessage.userInputMessage;
  assert.equal(current.userInputMessageContext.toolResults[0].toolUseId, "t1");
  assert.equal(current.content, "note");
});

test("Kiro context ending with an assistant message sends a Continue turn instead of duplicating history", async () => {
  const state = await captureConversationState([
    { role: "user", content: "hi" },
    assistantText("hello"),
  ]);
  assert.equal(state.history.length, 2);
  assert.equal(state.currentMessage.userInputMessage.content, "Continue");
});

test("Kiro leading developer message is not dropped", async () => {
  const state = await captureConversationState([
    { role: "developer", content: "ctx" },
    { role: "user", content: "go" },
  ]);
  assert.equal(state.history.length, 0);
  assert.equal(state.currentMessage.userInputMessage.content, "ctx\n\ngo");
});
