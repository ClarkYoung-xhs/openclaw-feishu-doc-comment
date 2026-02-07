/**
 * Feishu Document Comment Plugin for OpenClaw
 * 
 * Polls Feishu documents for new comments and responds via Agent.
 * Runs every 15 minutes (configurable).
 */

import axios, { AxiosInstance } from "axios";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Types
interface FeishuComment {
    comment_id: string;
    create_time: string;
    update_time: string;
    is_solved: boolean;
    solver_user_id?: string;
    reply_list?: {
        replies: FeishuReply[];
    };
    content: {
        elements: Array<{
            type: string;
            text_run?: { text: string };
        }>;
    };
    user_id: string;
    quote?: string;
}

interface FeishuReply {
    reply_id: string;
    user_id: string;
    create_time: string;
    content: {
        elements: Array<{
            type: string;
            text_run?: { text: string };
        }>;
    };
}

interface PluginConfig {
    enabled: boolean;
    pollIntervalMinutes: number;
    indexDocument?: string;  // Index document token - reads links from this doc
    watchedFiles: string[];  // Fallback: explicit list of document tokens
}

interface FeishuConfig {
    appId: string;
    appSecret: string;
}

interface ProcessedState {
    lastPollTime: number;
    processedComments: Record<string, string[]>; // fileToken -> commentId[]
}

// Plugin state
const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "state.json");
const CONFIG_FILE = join(__dirname, "config.json");

let accessToken: string | null = null;
let tokenExpiry = 0;

// Load plugin-specific config from config.json
function loadPluginConfig(): Partial<PluginConfig> {
    if (existsSync(CONFIG_FILE)) {
        try {
            return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
        } catch {
            console.log("[feishu-doc-comment] Failed to parse config file");
        }
    }
    return {};
}

// Helper functions
function loadState(): ProcessedState {
    if (existsSync(STATE_FILE)) {
        try {
            return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
        } catch {
            console.log("[feishu-doc-comment] Failed to parse state file, starting fresh");
        }
    }
    return { lastPollTime: 0, processedComments: {} };
}

function saveState(state: ProcessedState): void {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function extractTextFromContent(content: FeishuComment["content"]): string {
    if (!content?.elements) return "";
    return content.elements
        .filter((el) => el.type === "textRun" && el.text_run?.text)
        .map((el) => el.text_run!.text)
        .join("");
}

// Feishu API
async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
    const now = Date.now();
    if (accessToken && tokenExpiry > now) {
        return accessToken;
    }

    const response = await axios.post(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        { app_id: appId, app_secret: appSecret }
    );

    if (response.data.code !== 0) {
        throw new Error(`Failed to get access token: ${response.data.msg}`);
    }

    accessToken = response.data.tenant_access_token;
    tokenExpiry = now + (response.data.expire - 60) * 1000; // Refresh 60s before expiry
    return accessToken!;
}

async function getFileComments(
    client: AxiosInstance,
    fileToken: string,
    fileType: string = "docx"
): Promise<FeishuComment[]> {
    const response = await client.get(
        `/open-apis/drive/v1/files/${fileToken}/comments`,
        { params: { file_type: fileType } }
    );

    if (response.data.code !== 0) {
        console.error(`[feishu-doc-comment] Failed to get comments: ${response.data.msg}`);
        return [];
    }

    return response.data.data?.items || [];
}

// Get document content (raw blocks)
async function getDocumentContent(
    client: AxiosInstance,
    fileToken: string
): Promise<any> {
    try {
        const response = await client.get(
            `/open-apis/docx/v1/documents/${fileToken}/blocks`,
            { params: { page_size: 500 } }
        );

        if (response.data.code !== 0) {
            console.error(`[feishu-doc-comment] Failed to get doc content: ${response.data.msg}`);
            return null;
        }

        return response.data.data?.items || [];
    } catch (error) {
        console.error(`[feishu-doc-comment] Error getting doc content:`, error);
        return null;
    }
}

// Extract document links from blocks
function extractDocLinks(blocks: any[]): string[] {
    const docTokens: string[] = [];
    // Match docx/doc/wiki followed by token
    const docUrlPattern = /(?:docx?|wiki)\/([a-zA-Z0-9]+)/gi;

    function extractFromUrl(url: string) {
        const decodedUrl = decodeURIComponent(url);
        let match;
        // Reset regex lastIndex for global pattern
        docUrlPattern.lastIndex = 0;
        while ((match = docUrlPattern.exec(decodedUrl)) !== null) {
            const token = match[1];
            if (!docTokens.includes(token)) {
                docTokens.push(token);
                console.log(`[feishu-doc-comment] Found doc token: ${token}`);
            }
        }
    }

    function processElements(elements: any[]) {
        if (!elements) return;
        for (const element of elements) {
            // Check text_run for links
            const linkUrl = element.text_run?.text_element_style?.link?.url;
            if (linkUrl) {
                extractFromUrl(linkUrl);
            }
        }
    }

    for (const block of blocks) {
        // Process different block types that can contain elements
        // block_type 2 = text, 3 = heading1, 4 = heading2, 12 = bullet, 13 = ordered list, etc.
        const elementContainers = [
            block.text,
            block.heading1,
            block.heading2,
            block.heading3,
            block.heading4,
            block.heading5,
            block.heading6,
            block.heading7,
            block.heading8,
            block.heading9,
            block.bullet,
            block.ordered,
            block.page,
            block.callout,
            block.quote,
        ];

        for (const container of elementContainers) {
            if (container?.elements) {
                processElements(container.elements);
            }
        }
    }

    console.log(`[feishu-doc-comment] Extracted ${docTokens.length} document links from index`);
    return docTokens;
}

// Get watched files from index document
async function getWatchedFilesFromIndex(
    client: AxiosInstance,
    indexDocToken: string
): Promise<string[]> {
    const blocks = await getDocumentContent(client, indexDocToken);
    if (!blocks) {
        console.error(`[feishu-doc-comment] Could not read index document`);
        return [];
    }
    return extractDocLinks(blocks);
}


async function replyToComment(
    client: AxiosInstance,
    fileToken: string,
    commentId: string,
    replyText: string,
    fileType: string = "docx"
): Promise<boolean> {
    try {
        const response = await client.post(
            `/open-apis/drive/v1/files/${fileToken}/comments/${commentId}/replies`,
            {
                content: {
                    elements: [
                        {
                            type: "textRun",
                            textRun: { text: replyText },
                        },
                    ],
                },
            },
            { params: { file_type: fileType } }
        );

        if (response.data.code !== 0) {
            console.error(`[feishu-doc-comment] Failed to reply: ${response.data.msg}`);
            return false;
        }
        return true;
    } catch (error) {
        console.error("[feishu-doc-comment] Error replying to comment:", error);
        return false;
    }
}

// Agent integration
async function processCommentWithAgent(
    runtime: any,
    commentText: string,
    quote: string | undefined
): Promise<string> {
    const prompt = quote
        ? `用户在飞书文档中对以下内容划词评论：\n\n引用内容：「${quote}」\n\n评论：${commentText}\n\n请回复这条评论。`
        : `用户在飞书文档中发表了评论：${commentText}\n\n请回复这条评论。`;

    try {
        // Use OpenClaw runtime to invoke agent
        const result = await runtime.invoke({
            prompt,
            context: {
                source: "feishu-doc-comment",
                type: "document-comment",
            },
        });
        return result.response || "抱歉，我暂时无法处理这条评论。";
    } catch (error) {
        console.error("[feishu-doc-comment] Agent invocation failed:", error);
        return "抱歉，处理评论时遇到了问题，请稍后再试。";
    }
}

// Main polling logic
async function pollDocumentComments(
    config: PluginConfig,
    feishuConfig: FeishuConfig,
    runtime: any
): Promise<void> {
    if (!config.enabled) {
        console.log("[feishu-doc-comment] Plugin is disabled");
        return;
    }

    const state = loadState();
    const token = await getTenantAccessToken(feishuConfig.appId, feishuConfig.appSecret);

    const client = axios.create({
        baseURL: "https://open.feishu.cn",
        headers: { Authorization: `Bearer ${token}` },
    });

    // Get watched files: from index document or explicit config
    let watchedFiles: string[] = [];

    if (config.indexDocument) {
        console.log(`[feishu-doc-comment] Reading index document: ${config.indexDocument}`);
        watchedFiles = await getWatchedFilesFromIndex(client, config.indexDocument);
    }

    // Fallback to explicit config if index doc is empty or not configured
    if (watchedFiles.length === 0 && config.watchedFiles?.length > 0) {
        watchedFiles = config.watchedFiles;
    }

    if (watchedFiles.length === 0) {
        console.log("[feishu-doc-comment] No documents to watch (configure indexDocument or watchedFiles)");
        return;
    }

    console.log(`[feishu-doc-comment] Polling ${watchedFiles.length} document(s)...`);

    for (const fileToken of watchedFiles) {
        try {
            const comments = await getFileComments(client, fileToken);
            const processedIds = state.processedComments[fileToken] || [];

            for (const comment of comments) {
                // Skip if already processed
                if (processedIds.includes(comment.comment_id)) {
                    continue;
                }

                // Skip if comment is solved
                if (comment.is_solved) {
                    processedIds.push(comment.comment_id);
                    continue;
                }

                // Check if we already replied (look for bot's reply)
                const hasOurReply = comment.reply_list?.replies?.some(
                    (r) => r.user_id === "bot" // This needs to be the actual bot user id
                );
                if (hasOurReply) {
                    processedIds.push(comment.comment_id);
                    continue;
                }

                // New comment - process it
                const commentText = extractTextFromContent(comment.content);
                console.log(`[feishu-doc-comment] New comment: "${commentText.substring(0, 50)}..."`);

                const response = await processCommentWithAgent(runtime, commentText, comment.quote);
                const success = await replyToComment(client, fileToken, comment.comment_id, response);

                if (success) {
                    console.log(`[feishu-doc-comment] Replied to comment ${comment.comment_id}`);
                    processedIds.push(comment.comment_id);
                }
            }

            state.processedComments[fileToken] = processedIds;
        } catch (error) {
            console.error(`[feishu-doc-comment] Error processing file ${fileToken}:`, error);
        }
    }

    state.lastPollTime = Date.now();
    saveState(state);
    console.log("[feishu-doc-comment] Polling complete");
}

// Plugin entry point
export default function createPlugin(ctx: any) {
    const { config } = ctx;

    // Get feishu config from main feishu channel
    const feishuConfig: FeishuConfig = {
        appId: config.channels?.feishu?.appId || "",
        appSecret: config.channels?.feishu?.appSecret || "",
    };

    if (!feishuConfig.appId || !feishuConfig.appSecret) {
        console.error("[feishu-doc-comment] Feishu appId/appSecret not configured");
        return;
    }

    // Get plugin config: merge from config.json and openclaw.json
    const fileConfig = loadPluginConfig();
    const pluginConfig: PluginConfig = {
        enabled: config.plugins?.entries?.["feishu-doc-comment"]?.enabled ?? true,
        pollIntervalMinutes: fileConfig.pollIntervalMinutes ?? 15,
        indexDocument: fileConfig.indexDocument,
        watchedFiles: fileConfig.watchedFiles ?? [],
    };

    if (!pluginConfig.enabled) {
        console.log("[feishu-doc-comment] Plugin is disabled");
        return;
    }

    const indexInfo = pluginConfig.indexDocument
        ? `index doc: ${pluginConfig.indexDocument}`
        : `${pluginConfig.watchedFiles.length} watched files`;
    console.log(
        `[feishu-doc-comment] Initialized with ${indexInfo}, ` +
        `polling every ${pluginConfig.pollIntervalMinutes} minutes`
    );

    // Use setInterval for polling (simpler than cron)
    const pollIntervalMs = pluginConfig.pollIntervalMinutes * 60 * 1000;

    const doPoll = async () => {
        try {
            await pollDocumentComments(pluginConfig, feishuConfig, ctx);
        } catch (error) {
            console.error("[feishu-doc-comment] Poll error:", error);
        }
    };

    // Run immediately on startup after short delay
    setTimeout(doPoll, 10000);

    // Then poll at regular intervals
    setInterval(doPoll, pollIntervalMs);

    return {
        name: "feishu-doc-comment",
        version: "0.2.0",
    };
}
