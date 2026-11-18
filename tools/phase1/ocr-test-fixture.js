// A native executable fixture for Windows execFile; no product OCR code changes.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
export function windowsOcrFixture(scratch, stateFile) {
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!fs.existsSync(compiler)) throw Object.assign(new Error('installed .NET compiler is required for the original native OCR fixture'), { code: 'R2_FIXTURE_CAPABILITY_MISSING' });
  const source = path.join(scratch, 'fake-ocr.cs'), executable = path.join(scratch, 'fake-ocr.exe');
  const result = JSON.stringify({ ok: true, text: '张三 李四 2099年11月3日 09:30 第五法庭 这是一段足够长的测试文字内容', pages: 1, engine: 'vision' });
  fs.writeFileSync(source, `using System; using System.IO; using System.Text;
class Fixture { static int Main(string[] args) {
  string state = ${JSON.stringify(stateFile)};
  int count = int.Parse(File.ReadAllText(state)) + 1;
  File.WriteAllText(state, count.ToString());
  if (count > 1) return 1;
  Console.OutputEncoding = new UTF8Encoding(false);
  Console.WriteLine(${JSON.stringify(result)}); return 0;
} }`, 'utf8');
  const compiled = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${executable}`, source], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  console.log(JSON.stringify({ fixture: 'native-Windows-OCR', compiler, exit: compiled.status, output: (compiled.stdout || '') + (compiled.stderr || '') }));
  if (compiled.error || compiled.status !== 0) throw compiled.error || new Error('native OCR fixture compilation failed');
  return executable;
}
