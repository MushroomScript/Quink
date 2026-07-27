// 站点合规信息 (ICP / 公安备案号). 只走运行时 env 注入, 不写进源码也不打进镜像 ——
// 备案号绑定"域名 + 主体", 烤进公开 Docker 镜像会被别的部署方连带冒用 (违规).
// 部署方各自在自己的 .env 填自己的号; 不设 = 登录页不渲染备案区 (自部署 / 内网 / 桌面内嵌 server 的常态)

// ICP 备案号完整文字, 例: 京ICP备2026012345号-1
export const ICP_BEIAN = (process.env.QUINK_ICP_BEIAN || '').trim();

// 公安备案号完整文字, 例: 京公网安备 11010802012345号 (ICP 下来后去 beian.mps.gov.cn 单独申请)
export const POLICE_BEIAN = (process.env.QUINK_POLICE_BEIAN || '').trim();

// 公安备案查询链接只认纯数字 code, 从完整文字里抠出来, 省得部署方多填一个 env 还可能填不一致
export const POLICE_BEIAN_CODE = POLICE_BEIAN.match(/\d+/)?.[0] || '';
