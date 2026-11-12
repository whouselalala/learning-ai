/**
 * 检查 TTS 是否可用：node server/scripts/tts-check.js
 * 会尝试合成一句话并打印结果（本机 SAPI / 云 TTS 都可以用这个脚本验通）。
 */
import fs from 'node:fs';
import path from 'node:path';

const { config } = await import('../src/config.js');
const { synthesize, estimateDurationSec, mediaUrl } = await import('../src/lib/tts.js');

const text =
  '你好，我是小习。这是一段语音合成测试。听懂的同学，请在听到这句话之后，用自己的话说一遍今天最重要的那个结论。';

console.log(`provider=${config.tts.provider} voice=${config.tts.voice}`);
console.log(`预计时长 ${estimateDurationSec(text)} 秒`);

const started = Date.now();
const out = await synthesize(text, { key: 'tts-check' });
console.log(`耗时 ${Date.now() - started}ms`);
console.log(`audioFile=${out.audioFile || '（未生成）'} duration=${out.durationSec}s provider=${out.provider}`);
if (out.error) console.warn(`错误：${out.error}`);

if (out.audioFile) {
  const file = path.join(config.mediaDir, out.audioFile);
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  console.log(`文件 ${file}（${(size / 1024).toFixed(1)} KB），访问路径 ${mediaUrl(out.audioFile)}`);
  process.exit(size > 1024 ? 0 : 3);
}
console.log('未生成音频文件：课程会降级为「文本 + 计时」，或请在 .env 里配置 TTS_PROVIDER=http');
process.exit(1);
