// 预览启动器：固定使用项目内 .venv 的 Python 启动 uvicorn
// 不依赖系统 PATH 里的 python（避免 Windows 商店别名 / 缺依赖的问题）
// 额外命令行参数（如 --port xxxx）原样透传给 uvicorn，后面的 --port 生效
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const venvPy = process.platform === 'win32'
  ? join(root, '.venv', 'Scripts', 'python.exe')
  : join(root, '.venv', 'bin', 'python');
const py = existsSync(venvPy) ? venvPy : 'python';

const args = ['-m', 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', '7100',
  ...process.argv.slice(2)];

console.log(`[dev] ${py} ${args.join(' ')}`);
const child = spawn(py, args, { stdio: 'inherit', cwd: root });
child.on('error', err => { console.error('[dev] 启动失败:', err.message); process.exit(1); });
child.on('exit', code => process.exit(code ?? 0));
