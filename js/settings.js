/* ============================================================
 * 设置：一个真相来源
 *
 * Web 版由 ui.js 用 DOM 面板驱动，小游戏版由 minigame/ui2d.js 用
 * Canvas 面板驱动。两个 UI 后端必须改同一份设置对象、走同一个
 * apply()，否则「Web 上能开、小游戏上开了没用」这种问题
 * 只会在真机上被发现。
 *
 * 每一项都真实影响运行状态（不是摆设）：
 *   音量   → XS.Audio 的三条总线
 *   画质   → XS.Core.applyQuality（分辨率上限 / 泛光 / 粒子）
 *   震动   → XS.Core.shakeScale
 *   伤害数字 → UI.dmg 直接跳过
 *   色盲辅助 → XS.Game.applyA11y（妖魔高对比轮廓 + 稀有度标记）
 *   大字号 → UI 层的字号系数（Web 是 body.bigtext 的 --fs）
 *
 * 「真实影响运行状态」这条对无障碍开关尤其要紧：
 * 一个只写进存档却没接到渲染上的开关，从面板上看完全正常
 * （开关亮着、刷新还在、代码里搜得到），但屏幕上什么都没变。
 * 这类开关比没有更糟 —— 它让玩家以为自己已经开了。
 * 所以每次改动都会立刻调一次 apply，并且有 debugA11y() 可以直接验。
 * ============================================================ */
(function (global) {
  'use strict';
  var XS = global.XS || (global.XS = {});

  var Settings = XS.Settings = {
    master: 0.85, sfx: 0.78, music: 0.40,
    quality: 'auto', shake: 1, dmgNumbers: true,
    colorblind: false, bigText: false
  };

  Settings.save = function () {
    XS.Platform.save('settings', {
      master: Settings.master, sfx: Settings.sfx, music: Settings.music,
      quality: Settings.quality, shake: Settings.shake,
      dmgNumbers: Settings.dmgNumbers,
      colorblind: Settings.colorblind, bigText: Settings.bigText
    });
  };

  Settings.apply = function () {
    if (XS.Audio) {
      XS.Audio.setVolume('master', Settings.master);
      XS.Audio.setVolume('sfx', Settings.sfx);
      XS.Audio.setVolume('music', Settings.music);
    }
    if (XS.Core && XS.Core.applyQuality) XS.Core.applyQuality(Settings.quality);
    if (XS.Core) XS.Core.shakeScale = Settings.shake;
    if (XS.Game && XS.Game.applyA11y) XS.Game.applyA11y();
    /* 大字号在小游戏版里是 Canvas 的字号系数，在 Web 版里是 body 上的类。
       applyA11y 已经处理了 Web 那一半，这里再通知一次 UI 后端。 */
    if (XS.UI && XS.UI.onSettingsChanged) XS.UI.onSettingsChanged(Settings);
  };

  Settings.load = function () {
    var s = XS.Platform.load('settings', null);
    if (s && typeof s === 'object') {
      if (typeof s.master === 'number') Settings.master = s.master;
      if (typeof s.sfx === 'number') Settings.sfx = s.sfx;
      if (typeof s.music === 'number') Settings.music = s.music;
      if (typeof s.quality === 'string') Settings.quality = s.quality;
      if (typeof s.shake === 'number') Settings.shake = s.shake;
      if (typeof s.dmgNumbers === 'boolean') Settings.dmgNumbers = s.dmgNumbers;
      if (typeof s.colorblind === 'boolean') Settings.colorblind = s.colorblind;
      if (typeof s.bigText === 'boolean') Settings.bigText = s.bigText;
    }
    return Settings;
  };

  /* 字号系数：Canvas UI 直接乘在字号上；Web 版由 CSS 变量 --fs 处理。
     两个后端的数值必须一致，否则「大字号」在两端看起来不一样大。 */
  Settings.FS = 1.18;
  Settings.fontScale = function () { return Settings.bigText ? Settings.FS : 1; };

})(typeof window !== 'undefined' ? window : this);
