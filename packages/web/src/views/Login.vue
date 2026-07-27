<script setup lang="ts">
// 登录页设计约定 (蘑菇 2026-06-11 重构):
// - 分屏 (md+): 左侧 hero (brand + slogan + 4 帧产品 mock 轮播) / 右侧表单
// - 移动 (< 768px): 上下堆叠 — 顶部 brand + 表单
// - 背景固定浅色 (类 Linear/Notion 风, 不跟随主题), 主题色作装饰 (光晕 / 按钮 / mock chip) 让用户预览自己的主题
// - logo 用 quink-{currentTheme}-192.png, 用户看到自己主题色的 logo (登录前感知主题已生效)
// - 矮屏 / 低性能 / prefers-reduced-motion 自动停止轮播 + 关闭光晕动画
// - min-h-full + dvh 兼容 zoom 修正 (App.vue applyZoomLevel 调 __quink_setAppHeight)
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useTheme } from '@/composables/useTheme';
import { api } from '@/api';

const router = useRouter();
const auth = useAuthStore();
const currentTheme = useTheme();

const isRegister = ref(false);
const username = ref(localStorage.getItem('quink_last_username') || '');
const password = ref('');
const nickname = ref('');
const error = ref('');
const submitting = ref(false);

// 4 帧产品能力轮播: 快速记录 / AI 自动归档 / 跨设备同步 / 思考地图
const frames = [
  { key: 'capture',  title: '全局快捷键捕捉',   sub: '按下 Alt + Q, 在任何应用上一念即记' },
  { key: 'ai-tag',   title: 'AI 自动归档',       sub: '保存后 1-3 秒 AI 自动打标签、分类、生成摘要' },
  { key: 'sync',     title: '实时跨端同步',      sub: '桌面 / 手机 / 浏览器, 一处写下处处可见' },
  { key: 'map',      title: '看见你的思考轨迹',  sub: '热力图 / 分类环形图, 一年回看自己想过什么' },
];
const currentFrame = ref(0);
let timer: number | null = null;

// 备案信息 (ICP / 公安) 来自后端 env, 源码里没有值 —— 备案号绑定域名+主体, 不能进公开镜像被别人冒用.
// 部署方没配 env 时字段全空, 下面 v-if 整块不渲染
const beian = ref<{ icpBeian: string; policeBeian: string; policeBeianCode: string } | null>(null);

onMounted(() => {
  // 拿不到备案号不能挡住登录, 失败静默
  api.getSiteInfo().then((r) => { beian.value = r; }).catch(() => {});

  // 低性能 / 移动 / 用户偏好减少动画时停止自动轮播 — 仅保留手动点击切换
  const skipAutoplay = matchMedia('(max-width: 1024px), (prefers-reduced-motion: reduce)').matches;
  if (skipAutoplay) return;
  timer = window.setInterval(() => {
    currentFrame.value = (currentFrame.value + 1) % frames.length;
  }, 4500);
});
onBeforeUnmount(() => { if (timer != null) clearInterval(timer); });

function selectFrame(i: number) {
  currentFrame.value = i;
  if (timer != null) { clearInterval(timer); timer = null; }  // 用户手动选过后停掉自动轮播, 避免抢
}

async function handleSubmit() {
  error.value = '';
  submitting.value = true;
  try {
    if (isRegister.value) {
      if (!nickname.value.trim()) { error.value = '请输入昵称'; return; }
      await auth.register(username.value, password.value, nickname.value);
    } else {
      await auth.login(username.value, password.value);
    }
    localStorage.setItem('quink_last_username', username.value);
    router.push('/quink');
  } catch (err: any) {
    error.value = err.message || '操作失败';
  } finally {
    submitting.value = false;
  }
}

function toggleMode() { isRegister.value = !isRegister.value; error.value = ''; }
</script>

<template>
  <div class="login-page min-h-full">
    <div class="split">
      <!-- ── 左侧 hero (md+ 显示, 移动隐藏) ── -->
      <aside class="left">
        <!-- 主题色光晕装饰: 跟随用户当前主题, 登录前就能感知 -->
        <div class="glow glow-a" aria-hidden="true"></div>
        <div class="glow glow-b" aria-hidden="true"></div>

        <header class="brand-mini">
          <img :src="`/quink-${currentTheme}-192.png`" alt="" class="logo-mini" draggable="false" />
          <span>Quink</span>
        </header>

        <section class="hero">
          <h2>一念，<br/>即记。</h2>
          <p>不打断你的思考。<br/>不让你的灵感蒸发。</p>
        </section>

        <section class="showcase">
          <div class="shot-wrap">
            <!-- 帧 1: 全局快捷键捕捉 -->
            <div class="shot" :class="{ active: currentFrame === 0 }" aria-hidden="true">
              <div class="capture-card">
                <div class="capture-bar">
                  <span class="kbd">Alt</span> + <span class="kbd">Q</span>
                </div>
                <div class="capture-body">
                  <div class="capture-line">想到一句话——</div>
                  <div class="capture-line">写作不是给别人看的，是给未来的自己看的<span class="caret">|</span></div>
                </div>
                <div class="capture-foot">
                  <span class="dot type-quink">灵感</span>
                  <span class="dot type-note">笔记</span>
                  <span class="dot type-todo">待办</span>
                  <button class="capture-save" type="button" aria-hidden="true">
                    <span>保 存</span>
                    <span class="kbd-mini">↵</span>
                  </button>
                </div>
              </div>
            </div>

            <!-- 帧 2: AI 自动归档 -->
            <div class="shot" :class="{ active: currentFrame === 1 }" aria-hidden="true">
              <div class="note-card">
                <div class="note-head">
                  <span class="note-type">灵感</span>
                  <span class="note-time">刚刚 · AI 整理中</span>
                </div>
                <div class="note-body">
                  整理书柜时翻到三年前的日记，那时担心的事现在全忘了。突然想到——也许大多数焦虑都是这样。
                </div>
                <div class="note-tags">
                  <span class="tag tag-1">#反思</span>
                  <span class="tag tag-2">#日记</span>
                  <span class="tag tag-3">#日常</span>
                  <span class="tag tag-summary">摘要: 时间会让大多数焦虑变得不重要</span>
                </div>
              </div>
            </div>

            <!-- 帧 3: 实时跨端同步 -->
            <div class="shot" :class="{ active: currentFrame === 2 }" aria-hidden="true">
              <div class="devices">
                <div class="device dev-desktop">
                  <div class="device-screen">
                    <div class="device-bar"></div>
                    <div class="device-mini-card hl"></div>
                    <div class="device-mini-card"></div>
                    <div class="device-mini-card"></div>
                  </div>
                  <div class="device-label">桌面</div>
                </div>
                <div class="sync-flow" aria-hidden="true">
                  <span class="flow-dot d1"></span>
                  <span class="flow-dot d2"></span>
                  <span class="flow-dot d3"></span>
                </div>
                <div class="device dev-tablet">
                  <div class="device-screen">
                    <div class="device-bar"></div>
                    <div class="device-mini-card hl"></div>
                    <div class="device-mini-card"></div>
                  </div>
                  <div class="device-label">平板</div>
                </div>
                <div class="sync-flow" aria-hidden="true">
                  <span class="flow-dot d1"></span>
                  <span class="flow-dot d2"></span>
                  <span class="flow-dot d3"></span>
                </div>
                <div class="device dev-mobile">
                  <div class="device-screen">
                    <div class="device-bar"></div>
                    <div class="device-mini-card hl"></div>
                    <div class="device-mini-card"></div>
                  </div>
                  <div class="device-label">手机</div>
                </div>
              </div>
            </div>

            <!-- 帧 4: 思考地图 -->
            <div class="shot" :class="{ active: currentFrame === 3 }" aria-hidden="true">
              <div class="map">
                <!-- 左: 热力图 (年视图, 删了"365 天热力"标题让 mock 更紧凑. 7 行跟统计页热力图一致 (一周 7 天)) -->
                <div class="heatmap">
                  <span v-for="i in 7 * 14" :key="i" class="hm-cell" :style="{ '--lv': Math.max(0, Math.min(4, Math.floor((Math.sin(i * 0.7) + Math.cos(i * 0.3)) * 2 + 2))) }"></span>
                </div>
                <!-- 右: 饼图 + 分类 legend -->
                <div class="map-stats">
                  <div class="donut">
                    <svg viewBox="0 0 36 36">
                      <circle cx="18" cy="18" r="14" class="donut-bg" />
                      <circle cx="18" cy="18" r="14" class="donut-arc a1" stroke-dasharray="40 100" stroke-dashoffset="0" />
                      <circle cx="18" cy="18" r="14" class="donut-arc a2" stroke-dasharray="25 100" stroke-dashoffset="-40" />
                      <circle cx="18" cy="18" r="14" class="donut-arc a3" stroke-dasharray="18 100" stroke-dashoffset="-65" />
                      <circle cx="18" cy="18" r="14" class="donut-arc a4" stroke-dasharray="17 100" stroke-dashoffset="-83" />
                    </svg>
                    <div class="donut-cap">238<small>条</small></div>
                  </div>
                  <ul class="legend">
                    <li><i class="dot-a1"></i>工作 40%</li>
                    <li><i class="dot-a2"></i>学习 25%</li>
                    <li><i class="dot-a3"></i>生活 18%</li>
                    <li><i class="dot-a4"></i>其他 17%</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          <!-- 标题 + 副文案 (跟当前帧同步) -->
          <div class="frame-label">
            <div class="frame-title">{{ frames[currentFrame].title }}</div>
            <div class="frame-sub">{{ frames[currentFrame].sub }}</div>
          </div>

          <!-- 切换器 (圆点) -->
          <nav class="dots" role="tablist" aria-label="产品能力轮播">
            <button v-for="(f, i) in frames" :key="f.key"
              type="button"
              role="tab"
              :aria-selected="i === currentFrame"
              :aria-label="f.title"
              :class="{ active: i === currentFrame }"
              @click="selectFrame(i)"
              class="dot-btn">
            </button>
          </nav>
        </section>
      </aside>

      <!-- ── 右侧表单 ── -->
      <main class="right">
        <!-- 移动端沉浸 hero: 主题色区放大 logo + slogan (桌面隐藏, 桌面走左侧 hero) -->
        <header class="mobile-hero">
          <div class="mobile-hero-logo">
            <img :src="`/quink-${currentTheme}-192.png`" alt="" draggable="false" />
          </div>
          <div class="mobile-hero-name">Quink</div>
          <div class="mobile-hero-slogan">一念，即记。</div>
        </header>
        <div class="form-card">
          <h3 class="form-title">{{ isRegister ? '创建账号' : '欢迎回来' }}</h3>
          <p class="form-sub">{{ isRegister ? '开始记录你的第一念' : '灵感正在等你回来' }}</p>

          <form @submit.prevent="handleSubmit" class="form" novalidate>
            <div class="field">
              <label for="login-username">用户名</label>
              <input id="login-username" v-model="username" type="text" required autocomplete="username"
                placeholder="请输入用户名" spellcheck="false" />
            </div>

            <Transition name="field-grow">
              <div v-if="isRegister" class="field">
                <label for="login-nickname">昵称</label>
                <input id="login-nickname" v-model="nickname" type="text"
                  placeholder="别人看到的名字" spellcheck="false" />
              </div>
            </Transition>

            <div class="field">
              <label for="login-password">密码</label>
              <input id="login-password" v-model="password" type="password" required
                :autocomplete="isRegister ? 'new-password' : 'current-password'"
                placeholder="请输入密码" spellcheck="false" />
            </div>

            <Transition name="error-grow">
              <div v-if="error" class="form-error" role="alert">{{ error }}</div>
            </Transition>

            <button type="submit" :disabled="submitting" class="btn-primary">
              {{ submitting ? '请稍候…' : isRegister ? '注 册' : '登 录' }}
            </button>
          </form>

          <div class="switch">
            <button type="button" @click="toggleMode" class="switch-btn">
              {{ isRegister ? '已有账号？去登录' : '没有账号？去注册' }}
            </button>
          </div>

          <!-- 备案信息: 工信部要求 ICP 备案号展示在首页并链到 beian.miit.gov.cn, 公安要求网安备案号链到查询页.
               未登录打开站点看到的就是本页 = 首页. 两个号各自独立, 谁配了显示谁.
               放表单卡片内 (不是贴 .right 底部) 是因为显示比例 150% 时左侧 hero 把 .split 撑到 1134px 而视口逻辑高
               只有 600px, 贴底的话会被 .login-page 的 overflow:hidden 裁掉 —— 备案号是合规要求不能某些缩放下消失 -->
          <footer v-if="beian && (beian.icpBeian || beian.policeBeian)" class="beian">
            <a v-if="beian.icpBeian" href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">
              {{ beian.icpBeian }}
            </a>
            <a v-if="beian.policeBeian" :href="`https://beian.mps.gov.cn/#/query/webSearch?code=${beian.policeBeianCode}`"
              target="_blank" rel="noopener noreferrer">
              {{ beian.policeBeian }}
            </a>
          </footer>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════════════════
   登录页 — 分屏沉浸 (dark 固定 + 主题色装饰)
   ══════════════════════════════════════════════════════════════════════════ */

.login-page {
  /* 浅色版 (类 Linear / Notion 风): 极浅蓝白底, 主题色作装饰浮层 */
  background: #fafbfd;
  color: #0f172a;
  font-family: inherit;
  overflow: hidden;
  min-height: var(--app-height, 100dvh);
}

.split {
  display: grid;
  grid-template-columns: minmax(360px, 1.25fr) minmax(380px, 1fr);
  min-height: var(--app-height, 100dvh);
}

/* ── 左侧 hero ── */
.left {
  position: relative;
  padding: clamp(32px, 4.5vw, 64px) clamp(40px, 5.5vw, 80px);
  display: grid;
  grid-template-rows: auto auto 1fr;
  gap: clamp(20px, 3vh, 40px);
  overflow: hidden;
  background: linear-gradient(135deg, #f4f5fc 0%, #eef2ff 100%);
}

/* 装饰光晕 (跟随用户主题色). 浅色背景上要更柔, 用 c-accent-light 减刺眼 */
.glow {
  position: absolute;
  border-radius: 50%;
  filter: blur(100px);
  opacity: 0.5;
  pointer-events: none;
  will-change: transform;
}
.glow-a {
  width: 480px; height: 480px;
  top: -180px; left: -120px;
  background: rgb(var(--c-accent));
  animation: drift-a 24s ease-in-out infinite alternate;
}
.glow-b {
  width: 360px; height: 360px;
  bottom: -100px; right: -80px;
  background: rgb(var(--c-accent-light));
  opacity: 0.55;
  animation: drift-b 30s ease-in-out infinite alternate;
}
@keyframes drift-a {
  from { transform: translate(0, 0) scale(1); }
  to   { transform: translate(60px, 40px) scale(1.15); }
}
@keyframes drift-b {
  from { transform: translate(0, 0) scale(1); }
  to   { transform: translate(-50px, -60px) scale(1.2); }
}
@media (prefers-reduced-motion: reduce) {
  .glow-a, .glow-b { animation: none; }
}

/* 顶部 brand mini */
.brand-mini {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 10px;
}
.logo-mini {
  width: 32px; height: 32px;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgb(var(--c-accent) / 0.3);
}
.brand-mini span {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 1px;
  color: #0f172a;
}

/* hero slogan */
.hero {
  position: relative;
  z-index: 1;
  max-width: 520px;
}
.hero h2 {
  font-size: clamp(40px, 4.5vw, 64px);
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: -1px;
  margin-bottom: clamp(14px, 1.6vw, 22px);
  background: linear-gradient(120deg, #0f172a 40%, rgb(var(--c-accent-dark)) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.hero p {
  font-size: clamp(13px, 1.05vw, 16px);
  line-height: 1.75;
  color: #475569;
  max-width: 460px;
}

/* showcase 区: 截图 + 文案 + 圆点 */
.showcase {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-rows: 1fr auto auto;
  gap: 18px;
  align-self: end;
  width: 100%;
  max-width: 560px;
}

.shot-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 10;
  max-height: clamp(180px, 30vh, 340px);
  border-radius: 16px;
  border: 1px solid rgba(15, 23, 42, 0.06);
  background: rgba(255, 255, 255, 0.65);
  box-shadow:
    0 24px 48px rgba(15, 23, 42, 0.08),
    0 4px 12px rgba(15, 23, 42, 0.04);
  overflow: hidden;
  backdrop-filter: blur(12px);
}

.shot {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 减小 padding 让 mock 内容更贴近 shot-wrap 边缘, 不显空旷 */
  padding: clamp(10px, 1.5vw, 18px);
  opacity: 0;
  transform: scale(0.96);
  transition: opacity 0.7s ease, transform 0.7s ease;
  pointer-events: none;
}
.shot.active {
  opacity: 1;
  transform: scale(1);
}

/* ── 帧 1: 全局快捷键捕捉 ── */
.capture-card {
  width: 94%;
  max-width: 480px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 16px 36px rgba(15, 23, 42, 0.08);
}
.capture-bar {
  padding: 10px 14px;
  background: #f8fafc;
  border-bottom: 1px solid #f1f5f9;
  font-size: 12px;
  color: #94a3b8;
  letter-spacing: 1px;
}
.kbd {
  display: inline-block;
  padding: 2px 7px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 5px;
  font-size: 11px;
  color: #475569;
  margin: 0 2px;
  box-shadow: 0 1px 0 #e2e8f0;
}
.capture-body {
  padding: 26px 18px 16px;
  min-height: 108px;
}
.capture-line {
  font-size: 14px;
  color: #1f2937;
  line-height: 1.75;
}
.caret {
  display: inline-block;
  color: rgb(var(--c-accent));
  font-weight: 300;
  animation: blink 1s steps(2) infinite;
}
@keyframes blink {
  50% { opacity: 0; }
}
.capture-foot {
  padding: 10px 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  background: #fafbfd;
  border-top: 1px solid #f1f5f9;
}
.capture-foot .dot {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
}
.type-quink { background: rgb(var(--c-accent) / 0.15); color: rgb(var(--c-accent-dark)); font-weight: 500; }
.type-note  { background: #f1f5f9; color: #64748b; }
.type-todo  { background: #f1f5f9; color: #64748b; }
.capture-save {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 12px 4px 14px;
  border: none;
  border-radius: 999px;
  background: linear-gradient(135deg, rgb(var(--c-accent)) 0%, rgb(var(--c-accent-dark)) 100%);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 1px;
  box-shadow:
    0 3px 10px rgb(var(--c-accent) / 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
  cursor: default;
  font-family: inherit;
}
.capture-save .kbd-mini {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.25);
  font-size: 12px;
  font-weight: 400;
  color: #ffffff;
}

/* ── 帧 2: AI 自动归档 ── */
.note-card {
  width: 94%;
  max-width: 480px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  padding: 22px 24px;
  box-shadow: 0 16px 36px rgba(15, 23, 42, 0.08);
}
.note-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.note-type {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgb(var(--c-accent) / 0.15);
  color: rgb(var(--c-accent-dark));
  font-weight: 500;
}
.note-time {
  font-size: 11px;
  color: #94a3b8;
}
.note-time::after {
  content: '';
  display: inline-block;
  width: 8px; height: 8px;
  margin-left: 6px;
  border: 1.5px solid #e2e8f0;
  border-top-color: rgb(var(--c-accent));
  border-radius: 50%;
  vertical-align: -1px;
  animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.note-body {
  font-size: 13px;
  line-height: 1.8;
  color: #475569;
  margin-bottom: 16px;
}
.note-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.tag {
  font-size: 11px;
  padding: 4px 11px;
  border-radius: 999px;
  background: rgb(var(--c-accent) / 0.12);
  color: rgb(var(--c-accent-dark));
  font-weight: 500;
  opacity: 0;
  animation: tag-in 0.5s ease forwards;
}
.shot.active .tag-1 { animation-delay: 0.5s; }
.shot.active .tag-2 { animation-delay: 0.9s; }
.shot.active .tag-3 { animation-delay: 1.3s; }
.shot.active .tag-summary { animation-delay: 1.7s; }
@keyframes tag-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
.tag-summary {
  background: #f1f5f9;
  color: #64748b;
  font-weight: 400;
  font-style: normal;
  font-size: 11px;
  padding: 4px 11px;
}

/* ── 帧 3: 实时跨端同步 ── */
.devices {
  display: flex;
  align-items: flex-end;
  gap: clamp(10px, 2vw, 22px);
}
.device {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
}
.device-screen {
  border: 1.5px solid #cbd5e1;
  border-radius: 10px;
  background: #ffffff;
  padding: 7px;
  display: grid;
  gap: 5px;
  box-shadow: 0 6px 16px rgba(15, 23, 42, 0.08);
}
.dev-desktop .device-screen { width: 188px; aspect-ratio: 16 / 10; grid-template-rows: 12px repeat(3, 1fr); }
.dev-tablet  .device-screen { width: 110px; aspect-ratio: 3 / 4;   grid-template-rows: 10px repeat(2, 1fr); }
.dev-mobile  .device-screen { width: 68px;  aspect-ratio: 9 / 18;  grid-template-rows: 9px repeat(2, 1fr); }
.device-bar {
  background: #e2e8f0;
  border-radius: 2px;
}
.device-mini-card {
  background: #f1f5f9;
  border-radius: 4px;
}
.device-mini-card.hl {
  background: rgb(var(--c-accent));
  box-shadow: 0 0 14px rgb(var(--c-accent) / 0.55);
}
.device-label {
  font-size: 11px;
  color: #64748b;
  letter-spacing: 1px;
}
.sync-flow {
  display: flex;
  gap: 3px;
  margin-bottom: 18px;
}
.flow-dot {
  width: 4px; height: 4px;
  border-radius: 50%;
  background: rgb(var(--c-accent));
  opacity: 0.3;
}
.shot.active .flow-dot {
  animation: flow 1.6s ease infinite;
}
.shot.active .flow-dot.d1 { animation-delay: 0s; }
.shot.active .flow-dot.d2 { animation-delay: 0.2s; }
.shot.active .flow-dot.d3 { animation-delay: 0.4s; }
@keyframes flow {
  0%, 100% { opacity: 0.3; transform: translateX(0); }
  50%      { opacity: 1; transform: translateX(2px); }
}

/* ── 帧 4: 思考地图 ── 左右两栏 (heatmap | donut + legend), 浅色版去掉了 "365 天热力" 标题让 mock 更紧凑 */
.map {
  width: 100%;
  max-width: 460px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: clamp(14px, 2vw, 24px);
}
.heatmap {
  flex-shrink: 0;
  display: grid;
  grid-template-columns: repeat(14, minmax(0, 14px));   /* 跟其他帧视觉重量均衡, cell 14px 不让 map 横向太突出 */
  justify-content: start;
  gap: 3px;
}
.hm-cell {
  aspect-ratio: 1;
  border-radius: 2px;
  /* 浅色版要把最低明度托起来, 否则 lv=0 时几乎跟背景看不出差别 */
  background: rgb(var(--c-accent) / calc(0.12 + var(--lv) * 0.22));
}
.map-stats {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: clamp(10px, 1.5vw, 18px);
}
.donut {
  position: relative;
  width: clamp(86px, 9vw, 112px);
  aspect-ratio: 1;
  flex-shrink: 0;
}
.donut svg {
  width: 100%; height: 100%;
  transform: rotate(-90deg);
}
.donut circle {
  fill: none;
  stroke-width: 4;
}
.donut-bg { stroke: #e2e8f0; }
.donut-arc { stroke-linecap: round; transition: stroke-dashoffset 0.6s ease; }
.donut-arc.a1 { stroke: rgb(var(--c-accent)); }
.donut-arc.a2 { stroke: rgb(var(--c-accent-dark)); }
.donut-arc.a3 { stroke: rgb(var(--c-accent-light)); }
.donut-arc.a4 { stroke: #cbd5e1; }
.donut-cap {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: clamp(16px, 1.6vw, 22px);
  font-weight: 700;
  color: #0f172a;
  letter-spacing: -0.5px;
}
.donut-cap small {
  font-size: 9px;
  font-weight: 500;
  color: #94a3b8;
  margin-left: 2px;
}
.legend {
  list-style: none;
  font-size: 11px;
  color: #475569;
  display: grid;
  gap: 7px;
}
.legend i {
  display: inline-block;
  width: 9px; height: 9px;
  border-radius: 2px;
  margin-right: 9px;
  vertical-align: 1px;
}
.legend .dot-a1 { background: rgb(var(--c-accent)); }
.legend .dot-a2 { background: rgb(var(--c-accent-dark)); }
.legend .dot-a3 { background: rgb(var(--c-accent-light)); }
.legend .dot-a4 { background: #cbd5e1; }

/* 当前帧标题 + 副文案 */
.frame-label {
  min-height: 56px;  /* 高度固定避免帧切换跳动 */
}
.frame-title {
  font-size: clamp(15px, 1.3vw, 18px);
  font-weight: 600;
  color: #0f172a;
  margin-bottom: 4px;
}
.frame-sub {
  font-size: clamp(12px, 0.95vw, 14px);
  color: #64748b;
  line-height: 1.6;
}

/* 圆点切换器 */
.dots {
  display: flex;
  gap: 6px;
}
.dot-btn {
  width: 6px; height: 6px;
  border: none;
  border-radius: 999px;
  background: #cbd5e1;
  cursor: pointer;
  padding: 0;
  transition: width 0.3s ease, background 0.3s ease;
}
.dot-btn.active {
  width: 22px;
  background: rgb(var(--c-accent));
}

/* ══════════════════════════════════════════════════════════════════════════
   右侧表单
   ══════════════════════════════════════════════════════════════════════════ */

.right {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(32px, 5vw, 60px) clamp(24px, 4vw, 56px);
  /* 右侧白底打底 + 四角主题色柔光晕, 不抢戏但让背景不至于一刀切死板 */
  background:
    radial-gradient(at 85% 88%, rgb(var(--c-accent) / 0.09), transparent 55%),
    radial-gradient(at 12% 10%, rgb(var(--c-accent-light) / 0.55), transparent 50%),
    #ffffff;
  position: relative;
  overflow: hidden;
}

/* 右侧装饰 blob: 静态 (不带 animation) 让右侧不抢左侧 hero 区视觉, 仅作背景"呼吸" */
.right::before {
  content: '';
  position: absolute;
  top: -100px;
  right: -120px;
  width: 360px;
  height: 360px;
  border-radius: 50%;
  background: rgb(var(--c-accent));
  opacity: 0.08;
  filter: blur(80px);
  pointer-events: none;
}
.right::after {
  content: '';
  position: absolute;
  bottom: -140px;
  left: -80px;
  width: 300px;
  height: 300px;
  border-radius: 50%;
  background: rgb(var(--c-accent-light));
  opacity: 0.45;
  filter: blur(90px);
  pointer-events: none;
}

.right > * { position: relative; z-index: 1; }

.form-card {
  width: 100%;
  max-width: 360px;
}

/* 移动 hero (桌面隐藏; 移动端 media query 内显示为沉浸品牌区) */
.mobile-hero {
  display: none;
}

.form-title {
  font-size: clamp(22px, 2vw, 28px);
  font-weight: 700;
  color: #0f172a;
  margin-bottom: 6px;
  letter-spacing: -0.5px;
}
.form-sub {
  font-size: 13px;
  color: #64748b;
  margin-bottom: 28px;
}

.form {
  display: grid;
  gap: 16px;
}

.field label {
  display: block;
  font-size: 11px;
  color: #64748b;
  margin-bottom: 6px;
  font-weight: 500;
  letter-spacing: 1px;
  text-transform: uppercase;
}
.field input {
  width: 100%;
  padding: 11px 14px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #f8fafc;
  font-size: 14px;
  color: #0f172a;
  outline: none;
  transition: border-color 0.2s, background 0.2s, box-shadow 0.2s;
  font-family: inherit;
}
.field input::placeholder {
  color: #94a3b8;
}
.field input:focus {
  border-color: rgb(var(--c-accent));
  background: #ffffff;
  box-shadow: 0 0 0 3px rgb(var(--c-accent) / 0.12);
}

.form-error {
  font-size: 12px;
  color: #dc2626;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 10px;
  padding: 8px 12px;
}

.btn-primary {
  width: 100%;
  padding: 12px;
  border: none;
  border-radius: 10px;
  background: linear-gradient(135deg, rgb(var(--c-accent)) 0%, rgb(var(--c-accent-dark)) 100%);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 2px;
  cursor: pointer;
  box-shadow:
    0 6px 20px rgb(var(--c-accent) / 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.18);
  transition: transform 0.1s, box-shadow 0.2s;
  margin-top: 4px;
}
.btn-primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 8px 28px rgb(var(--c-accent) / 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.25);
}
.btn-primary:active { transform: translateY(0); }
.btn-primary:disabled { opacity: 0.55; cursor: not-allowed; }

.switch {
  margin-top: 22px;
  text-align: center;
}
.switch-btn {
  background: none;
  border: none;
  color: #64748b;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  transition: color 0.15s;
}
.switch-btn:hover {
  color: rgb(var(--c-accent-dark));
}

/* 备案信息: 跟表单同一文档流 (卡片内最底), 表单可见它就可见 —— 各显示比例下都不会被裁掉 */
.beian {
  margin-top: 30px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px 16px;
  font-size: 11px;
  line-height: 1.6;
}
.beian a {
  color: #94a3b8;
  text-decoration: none;
  transition: color 0.15s;
}
.beian a:hover {
  color: #64748b;
  text-decoration: underline;
}

/* 表单切换登录 / 注册时 昵称字段展开收起动画 */
.field-grow-enter-active, .field-grow-leave-active {
  transition: max-height 0.35s ease, opacity 0.25s ease, margin 0.35s ease;
  overflow: hidden;
}
.field-grow-enter-from, .field-grow-leave-to {
  max-height: 0;
  opacity: 0;
  margin: -8px 0 0;
}
.field-grow-enter-to, .field-grow-leave-from {
  max-height: 80px;
  opacity: 1;
}

.error-grow-enter-active, .error-grow-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.error-grow-enter-from, .error-grow-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* ══════════════════════════════════════════════════════════════════════════
   响应式: 移动 (< 768px) 上下堆叠 + 矮屏处理
   ══════════════════════════════════════════════════════════════════════════ */

/* 移动端: 单列堆叠. 左侧 hero 隐藏, 右侧承担 brand 展示 */
@media (max-width: 768px) {
  .split {
    grid-template-columns: 1fr;
  }
  .left {
    display: none;
  }
  /* 移动端不跟随主题色 (蓝绿撞色难看): 极浅蓝灰底 + 品牌蓝 logo/按钮, 蓝色系自协调 */
  .login-page {
    background: #f4f6fb;
  }
  .right {
    padding: 0;
    display: flex;
    flex-direction: column;
    background: transparent;
  }
  /* 移动端去掉右侧主题色光晕 (桌面用的 ::before/::after 装饰) */
  .right::before, .right::after {
    display: none;
  }
  /* 移动 hero: logo + 品牌名 + slogan, 深色字在浅底上 */
  .mobile-hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: clamp(24px, 5vh, 40px) 24px clamp(26px, 5vh, 38px);
    text-align: center;
  }
  .mobile-hero-logo {
    width: 62px;
    height: 62px;
    border-radius: 17px;
    overflow: hidden;
    background: #f4f6fb;  /* = hero 底色, 裁剩的极少透明边融入 hero 无浅边 */
    box-shadow: 0 12px 30px rgba(37, 99, 235, 0.28);
  }
  .mobile-hero-logo img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transform: scale(1.3);  /* 裁掉图片四周透明 padding (12%), 保留白 Q */
  }
  .mobile-hero-name {
    font-size: 26px;
    font-weight: 700;
    color: #0f172a;
    letter-spacing: 2px;
    text-indent: 2px;  /* 补偿 letter-spacing 造成的整体右偏, 视觉居中 */
  }
  .mobile-hero-slogan {
    font-size: 13px;
    color: #94a3b8;
    letter-spacing: 4px;
    text-indent: 9px;  /* 补偿 letter-spacing + 末尾圆角句号"。"右半空白造成的视觉左偏, 往右挪 */
  }
  /* 表单白卡: flex-1 撑满 hero 以下 (贴底顶部大圆角), 内部表单垂直居中让上下留白对称 */
  .form-card {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    background: #ffffff;
    border-radius: 30px 30px 0 0;
    padding: 24px 26px calc(24px + env(safe-area-inset-bottom, 0px));
    box-shadow: 0 -8px 36px rgba(15, 23, 42, 0.07);
    width: 100%;
    max-width: none;
  }
  /* 移动端去掉标题 "欢迎回来" + 副标题 (蘑菇要求, 更简约, 直接进表单) */
  .form-title, .form-sub { display: none; }
  /* 登录按钮 / input focus / switch 跟主题色 (继承桌面, 不再写死品牌蓝) —— 跟 logo 一致跟随主题 */
}

/* 中屏低高度 (笔记本 1366×768 等): 控制 hero 字号 + 截图高度避免溢出 */
@media (min-width: 769px) and (max-height: 740px) {
  .hero h2 { font-size: clamp(32px, 3.5vw, 42px); }
  .shot-wrap { max-height: 210px; }
  .left { gap: 16px; padding-top: 28px; padding-bottom: 28px; }
}

/* 极矮屏 (< 600px 高): 允许整页竖滚, 不强行塞下 */
@media (max-height: 600px) {
  .login-page { overflow-y: auto; }
  .split { min-height: auto; }
}
</style>
