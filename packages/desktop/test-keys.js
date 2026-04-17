const { uIOhook, UiohookKey } = require('uiohook-napi');

// 反查 keycode → 键名
const codeToName = {};
for (const [name, code] of Object.entries(UiohookKey)) {
  if (isNaN(Number(name))) {
    codeToName[code] = name;
  }
}

const pressed = new Set();

console.log('=== 按键测试器 ===');
console.log('按任意键查看 keycode，按 Esc 退出');
console.log('');

uIOhook.on('keydown', (e) => {
  pressed.add(e.keycode);
  const names = [...pressed].map(k => codeToName[k] || `?${k}`);
  const combo = names.join(' + ');
  process.stdout.write(`\r按下: ${combo.padEnd(50)}`);
});

uIOhook.on('keyup', (e) => {
  if (e.keycode === UiohookKey.Escape) {
    console.log('\n退出');
    uIOhook.stop();
    process.exit(0);
  }
  pressed.delete(e.keycode);
  if (pressed.size === 0) {
    process.stdout.write(`\r等待按键...                                        `);
  }
});

uIOhook.start();
