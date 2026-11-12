import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { id } from './ids.js';

/** 朗读前清洗：去掉 Markdown、括号注释、表情，避免 TTS 念出符号 */
export function cleanForSpeech(text = '') {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_>`~]/g, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/【(.*?)】/g, '$1，')
    .replace(/[（(]\s*[)）]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 估算时长：中文有声书约 4.5 字/秒，加标点停顿 */
export function estimateDurationSec(text = '') {
  const chars = cleanForSpeech(text).replace(/\s/g, '').length;
  return Math.max(20, Math.round(chars / 4.4));
}

/** 解析 WAV 头，取真实时长（SAPI 输出为 PCM，便于准确计费） */
export function wavDurationSec(buffer) {
  if (!buffer || buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return 0;
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ' && offset + 8 + 16 <= buffer.length) {
      byteRate = buffer.readUInt32LE(offset + 8 + 8);
    } else if (chunkId === 'data') {
      dataSize = Math.min(chunkSize, buffer.length - offset - 8);
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (!byteRate || !dataSize) return 0;
  return Math.round(dataSize / byteRate);
}

function resolvePowerShell() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
  ];
  for (const c of candidates) {
    try {
      if (c.endsWith('powershell.exe') && c.includes(path.sep) && !fs.existsSync(c)) continue;
      return c;
    } catch {
      /* ignore */
    }
  }
  return 'powershell.exe';
}

function run(file, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { stdio: 'ignore', windowsHide: true });
    } catch (err) {
      resolve({ code: -1, error: err.message });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ code: -2, error: 'TTS 超时' });
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, error: code === 0 ? null : `TTS 进程退出码 ${code}` });
    });
  });
}

/** 本机 Windows 语音（开发演示用；正式环境请换成云 TTS） */
async function synthesizeSapi(text, filename) {
  const outFile = path.join(config.mediaDir, filename);
  const txtFile = path.join(config.mediaDir, 'tmp', `${id('tts')}.txt`);
  fs.mkdirSync(path.dirname(txtFile), { recursive: true });
  fs.writeFileSync(txtFile, text, 'utf8');
  const ps = resolvePowerShell();
  const script = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'sapi-tts.ps1');
  const { code, error } = await run(ps, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-TextFile',
    txtFile,
    '-OutFile',
    outFile,
    '-Voice',
    config.tts.voice,
    '-Rate',
    String(config.tts.rate),
  ]);
  fs.rmSync(txtFile, { force: true });
  if (code !== 0 || !fs.existsSync(outFile) || fs.statSync(outFile).size < 1024) {
    fs.rmSync(outFile, { force: true });
    return { audioFile: null, durationSec: 0, error: error || '语音合成未生成有效文件' };
  }
  const duration = wavDurationSec(fs.readFileSync(outFile));
  return { audioFile: filename, durationSec: duration || estimateDurationSec(text), error: null };
}

/** 通用 HTTP TTS：POST {text, voice, format} -> {audioBase64} 或 {audioUrl} */
async function synthesizeHttp(text, filename) {
  if (!config.tts.httpUrl) return { audioFile: null, durationSec: 0, error: '未配置 TTS_HTTP_URL' };
  const res = await fetch(config.tts.httpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.tts.httpKey ? { authorization: `Bearer ${config.tts.httpKey}` } : {}),
    },
    body: JSON.stringify({ text, voice: config.tts.voice, format: 'wav' }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) return { audioFile: null, durationSec: 0, error: `TTS 服务返回 ${res.status}` };
  const data = await res.json();
  if (data.audioBase64) {
    const buf = Buffer.from(data.audioBase64, 'base64');
    fs.mkdirSync(config.mediaDir, { recursive: true });
    fs.writeFileSync(path.join(config.mediaDir, filename), buf);
    return { audioFile: filename, durationSec: wavDurationSec(buf) || estimateDurationSec(text), error: null };
  }
  if (data.audioUrl) return { audioFile: data.audioUrl, durationSec: Number(data.durationSec) || estimateDurationSec(text), error: null };
  return { audioFile: null, durationSec: 0, error: 'TTS 返回格式不支持' };
}

/**
 * 合成一段课程音频。失败不抛错：返回 audioFile=null，前端可退回“文本跟读/系统朗读”。
 * @returns {{audioFile: string|null, durationSec: number, provider: string, error: string|null}}
 */
export async function synthesize(text, { key = 'lesson' } = {}) {
  const clean = cleanForSpeech(text);
  if (!clean) return { audioFile: null, durationSec: 0, provider: 'none', error: '文本为空' };
  const filename = `${key.replace(/[^\w.-]/g, '_')}.wav`;
  const provider = config.tts.provider;

  try {
    if (provider === 'mock' || provider === 'none') {
      return { audioFile: null, durationSec: estimateDurationSec(clean), provider: 'mock', error: null };
    }
    if (provider === 'http') {
      const out = await synthesizeHttp(clean, filename);
      return { ...out, provider: 'http' };
    }
    const out = await synthesizeSapi(clean, filename);
    return { ...out, provider: 'sapi' };
  } catch (err) {
    return { audioFile: null, durationSec: estimateDurationSec(clean), provider, error: err.message };
  }
}

export function mediaUrl(audioFile) {
  if (!audioFile) return null;
  if (/^https?:\/\//.test(audioFile)) return audioFile;
  return `/media/${audioFile}`;
}

export function ttsInfo() {
  return {
    provider: config.tts.provider,
    voice: config.tts.voice,
    note:
      config.tts.provider === 'sapi'
        ? '本机语音合成（仅开发演示；生产请用 TTS_PROVIDER=http 接入云厂商）'
        : undefined,
  };
}
