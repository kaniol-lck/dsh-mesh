/**
 * hub console design tokens — one semantic vocabulary for the standalone console.
 *
 * The console is not a DSH plugin, so it cannot use `--dsw-*` variables directly; these
 * tokens carry the same names and the official light/dark values so both surfaces look
 * like one product. Each entry names the official alias it follows; where the official
 * scale has no matching alias the existing console value is kept and marked 本地值.
 */
export const TOKENS = {
  color: {
    // 官方 --dsw-alias-bg-layer-2 = #fff（卡片/表格底）
    surface: '#fff',
    // 官方 --dsw-static-neutral-bluish-60 = #f5f6f7（页面底）
    surfaceMuted: '#f5f6f7',
    // 官方 --dsw-static-neutral-bluish-75 = #f1f3f5（内嵌块/令牌框）
    surfaceInset: '#f1f3f5',
    // 官方 --dsw-alias-border-l2 = #0000001a（卡片/表格描边）
    border: '#0000001a',
    // 官方 --dsw-alias-border-l1 = #0000000a（行分隔）
    borderSubtle: '#0000000a',
    // 官方 --dsw-static-neutral-300 = #d4d4d4（输入框描边）
    borderStrong: '#d4d4d4',
    // 官方 --dsw-static-neutral-bluish-400 = #adb2b8（虚线框；原 #9ca3af）
    borderDashed: '#adb2b8',
    // 官方 --dsw-alias-label-primary = #0f1115
    text: '#0f1115',
    // 官方 --dsw-alias-label-secondary = #61666b
    textMuted: '#61666b',
    // 官方 --dsw-alias-label-tertiary = #81858c
    textFaint: '#81858c',
    // 本地值，无官方对应（官方 state-success-primary 太亮，不适合正文）
    success: '#15803d',
    // 官方 --dsw-alias-state-success-tertiary = #e6faed
    successBg: '#e6faed',
    // 本地值，无官方对应（浅绿描边）
    successBorder: '#bbf7d0',
    // 本地值，无官方对应（官方 warn-label #dd8629 对比度不足）
    warning: '#b45309',
    // 官方 --dsw-alias-state-warn-tertiary = #fef5e7
    warningBg: '#fef5e7',
    // 本地值，无官方对应（浅黄描边）
    warningBorder: '#fde68a',
    // 本地值，无官方对应（官方 state-error-primary #ec1313 太亮）
    danger: '#b91c1c',
    // 官方 --dsw-alias-brand-primary = #0f1115（主按钮底）
    primary: '#0f1115',
    // 官方 --dsw-alias-label-primary-inverted = #fff
    onPrimary: '#fff',
  },
  // 官方深色主题取值（body[data-ds-dark-theme]），只覆盖有差异的颜色。
  dark: {
    // 官方 --dsw-alias-bg-layer-1 = #232324
    surface: '#232324',
    // 官方 --dsw-alias-bg-base = #151517
    surfaceMuted: '#151517',
    // 官方 --dsw-alias-bg-layer-2 = #2c2c2e
    surfaceInset: '#2c2c2e',
    // 官方 --dsw-alias-border-l2 = #ffffff1f
    border: '#ffffff1f',
    // 官方 --dsw-alias-border-l1 = #ffffff0f
    borderSubtle: '#ffffff0f',
    // 官方 --dsw-alias-border-l3 = #ffffff29
    borderStrong: '#ffffff29',
    // 本地值，无官方对应（深色虚线框）
    borderDashed: '#878b91',
    // 官方 --dsw-alias-label-primary = #f9fafb
    text: '#f9fafb',
    // 官方 --dsw-alias-label-secondary = #cfd3d6
    textMuted: '#cfd3d6',
    // 官方 --dsw-alias-label-caption = #979da6
    textFaint: '#979da6',
    // 本地值，无官方对应（深色成功文字）
    success: '#4ade80',
    // 官方 --dsw-alias-state-success-tertiary（深色）= #233c2c
    successBg: '#233c2c',
    // 本地值，无官方对应（深色成功描边）
    successBorder: '#2f5a3d',
    // 本地值，无官方对应（深色告警文字）
    warning: '#fbbf24',
    // 官方 --dsw-alias-state-warn-tertiary（深色）= #27241f
    warningBg: '#27241f',
    // 本地值，无官方对应（深色告警描边）
    warningBorder: '#5a4a26',
    // 本地值，无官方对应（深色危险色）
    danger: '#f87171',
    // 官方 --dsw-alias-brand-primary（深色）= #f9fafb
    primary: '#f9fafb',
    // 官方 --dsw-alias-label-primary-foreground（深色）= #0f1115
    onPrimary: '#0f1115',
  },
  font: {
    // 官方 --dsw-font-xxxs-11 = 11px
    xs: 11,
    // 官方 --dsw-font-xxs-12 = 12px
    sm: 12,
    // 官方 --dsw-font-xs-13 = 13px
    md: 13,
    // 官方 --dsw-font-s-14 = 14px
    lg: 14,
    // 官方 --dsw-font-l-20 = 20px
    xl: 20,
    // 本地值，无官方对应（统计卡片数字）
    display: 22,
    // 本地值，无官方对应（注册码大字）
    hero: 26,
  },
  radius: {
    // 本地值，无官方对应（官方 radius-lg = 16px；控制台卡片沿用 10px）
    lg: 10,
  },
}

export default TOKENS
