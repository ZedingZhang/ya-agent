import { createInterface } from "node:readline/promises";
import type { CliContext, CliIo, InputStream, OutputStream } from "./types";

export function write(stream: OutputStream, value: string): void {
  stream.write(value);
}

function defaultPrompt(stdin: InputStream, stdout: OutputStream): CliIo["prompt"] {
  return async (question, hidden = false, signal) => {
    if (hidden && stdin.isTTY && stdin.setRawMode) return readHidden(question, stdin, stdout);
    const prompt = createInterface({ input: stdin, output: stdout });
    const inputCancellation = new AbortController();
    const promptSignal = signal ? AbortSignal.any([signal, inputCancellation.signal]) : inputCancellation.signal;
    // readline handles terminal Ctrl+C itself while a question is active.
    prompt.once("SIGINT", () => {
      inputCancellation.abort(new Error("Input cancelled."));
      if (process.listenerCount("SIGINT") > 0) process.emit("SIGINT");
    });
    try {
      return await prompt.question(question, { signal: promptSignal });
    } finally {
      prompt.close();
    }
  };
}

function readHidden(question: string, stdin: InputStream, stdout: OutputStream): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    write(stdout, question);
    const previousRaw = Boolean(stdin.isRaw);
    let value = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode?.(previousRaw);
      stdin.pause();
      write(stdout, "\n");
    };
    const onData = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      for (const character of text) {
        if (character === "\r" || character === "\n") {
          cleanup();
          resolvePromise(value);
          return;
        }
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Credential entry cancelled."));
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    stdin.on("data", onData);
  });
}

export function makeIo(context?: CliContext): CliIo {
  if (context?.io) return context.io;
  const stdin = process.stdin as InputStream;
  const stdout = process.stdout as OutputStream;
  return { stdin, stdout, stderr: process.stderr as OutputStream, prompt: defaultPrompt(stdin, stdout) };
}

export function parseInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer.`);
  return parsed;
}

export function collectValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}
