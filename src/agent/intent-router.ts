import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface IntentClassificationResult {
  label: 'chat' | 'task';
  confidence: number;
  raw: string;
}

/**
 * One-shot intent classifier. Runs `opencode run` with a strict one-line JSON
 * answer prompt and parses the result. Fail-open: classification errors return
 * {label:'task', confidence:0} so the message still gets executed.
 */
export async function classifyIntent(command: string, modelOverride?: string): Promise<IntentClassificationResult> {
  const prompt = [
    '你只做意图分类，不执行任务。',
    '输出且仅输出一行 JSON：{"label":"chat|task","confidence":0.00}',
    'chat=闲聊问答/状态询问；task=需要实际操作（改代码、分析、搜索、处理文件、运行命令等）。',
    `用户消息：${command}`,
  ].join('\n');

  const args = ['run', prompt, '--format', 'json'];
  const model = modelOverride || config.opencode.model;
  if (model) {
    args.push('--model', model);
  }

  const timeout = Math.max(3000, config.opencode.intentRoutingTimeout || 12000);

  return await new Promise<IntentClassificationResult>((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finalize = (result: IntentClassificationResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolveResult(result);
    };

    let child: ReturnType<typeof spawn> | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      child = spawn(config.opencode.path, args, {
        cwd: config.opencode.workingDir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Intent classification spawn failed: ${message}`);
      finalize({ label: 'task', confidence: 0, raw: message });
      return;
    }

    timeoutHandle = setTimeout(() => {
      try {
        child?.kill('SIGTERM');
      } catch {
        // ignore
      }
      finalize({ label: 'task', confidence: 0, raw: 'timeout' });
    }, timeout);

    child.stdout?.on('data', (data: Buffer | string) => {
      stdout += typeof data === 'string' ? data : data.toString();
    });
    child.stderr?.on('data', (data: Buffer | string) => {
      stderr += typeof data === 'string' ? data : data.toString();
    });

    child.on('error', (error: Error) => {
      logger.warn(`Intent classification process error: ${error.message}`);
      finalize({ label: 'task', confidence: 0, raw: error.message });
    });

    child.on('close', (code: number | null) => {
      const extracted = extractTextFromJsonEvents(stdout);
      const parsed = parseClassification(extracted);
      if (parsed) {
        finalize(parsed);
        return;
      }
      if (code !== 0) {
        logger.warn(`Intent classification exited with code ${code}: ${stderr.trim().slice(0, 200)}`);
      }
      finalize({ label: 'task', confidence: 0, raw: extracted || stderr.trim() });
    });
  });
}

function extractTextFromJsonEvents(raw: string): string {
  const textChunks: string[] = [];
  for (const line of raw.split(/\r?\n/).map(item => item.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === 'text') {
        const part = parsed.part as Record<string, unknown> | undefined;
        if (part && typeof part.text === 'string') {
          textChunks.push(part.text);
        }
      }
    } catch {
      textChunks.push(line);
    }
  }
  return textChunks.join('\n').trim();
}

function parseClassification(rawText: string): IntentClassificationResult | null {
  if (!rawText) {
    return null;
  }

  const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  const candidate = jsonMatch?.[0] || cleaned;

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const labelRaw = typeof parsed.label === 'string' ? parsed.label.toLowerCase() : '';
    if (labelRaw !== 'chat' && labelRaw !== 'task') {
      return null;
    }
    const confidenceRaw = parsed.confidence;
    const confidenceValue = typeof confidenceRaw === 'number' ? confidenceRaw : Number.parseFloat(String(confidenceRaw ?? '0.5'));
    const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : 0.5;
    return { label: labelRaw, confidence, raw: cleaned };
  } catch {
    const lower = cleaned.toLowerCase();
    if (lower.includes('chat') && !lower.includes('task')) {
      return { label: 'chat', confidence: 0.6, raw: cleaned };
    }
    if (lower.includes('task') || lower.includes('任务')) {
      return { label: 'task', confidence: 0.6, raw: cleaned };
    }
    return null;
  }
}
