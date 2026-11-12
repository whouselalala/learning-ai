const util = require('../../utils/util.js');
const api = require('../../utils/api.js');

const HEARTBEAT_MS = 15000;

Page({
  data: {
    lesson: null,
    paragraphs: [],
    loading: true,
    playing: false,
    clock: '00:00',
    costText: '本次 0.00 元',
    fundingText: '免费体验',
    fundingClass: 'gray',
    progress: 0,
    note: '',
  },

  onLoad(options) {
    this.lessonId = options.lessonId;
    if (!this.lessonId) {
      util.toast('缺少课程参数');
      return;
    }
    this.audio = null;
    this.session = null;
    this.played = 0;
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const out = await api.post(`/api/lessons/${this.lessonId}/audio`);
      const lesson = out.lesson;
      const paragraphs = String(lesson.script || '').split(/\n{2,}/).filter(Boolean);
      const note = lesson.audioUrl
        ? '服务端音频已就绪，按实际播放时长计费；离开页面会自动结算。'
        : '本机未配置 TTS，先用「文本 + 计时」模式演示：点开始即开始计时，读讲稿即可。';
      this.setData({
        lesson,
        paragraphs,
        loading: false,
        note,
        fundingText: '免费体验',
        fundingClass: 'gray',
      });
      if (lesson.audioUrl) this.setupAudio(lesson.audioUrl);
      wx.setNavigationBarTitle({ title: lesson.title });
    } catch (err) {
      this.setData({ loading: false });
      util.toast(err.message);
    }
  },

  setupAudio(url) {
    this.audio = wx.createInnerAudioContext();
    this.audio.src = url.startsWith('http') ? url : api.BASE_URL + url;
    this.audio.onEnded(() => this.onStop(true));
    this.audio.onError((e) => {
      console.warn('audio error', e);
      util.toast('音频加载失败，可用文本模式');
    });
  },

  async onStart() {
    if (this.data.playing) return;
    try {
      const out = await api.post('/api/sessions', { lessonId: this.lessonId });
      this.session = out.session;
      this.startedAt = Date.now();
      this.trialLeft = out.session.trialSecondsLeft;
      this.setData({
        playing: true,
        fundingText: out.session.funding === 'trial' ? '免费体验中' : '会员计费中',
        fundingClass: out.session.funding === 'trial' ? 'green' : 'orange',
      });
      this.tickTimer = setInterval(() => this.tick(), 1000);
      this.beatTimer = setInterval(() => this.beat(), HEARTBEAT_MS);
      if (this.audio) this.audio.play();
    } catch (err) {
      this.handleGate(err);
    }
  },

  tick() {
    const played = Math.floor((Date.now() - this.startedAt) / 1000);
    this.played = played;
    const total = Math.max(this.data.lesson.durationSec || 600, 60);
    const paidSec = Math.max(0, played - (this.trialLeft || 0));
    this.setData({
      clock: util.mmss(played),
      costText: `本次 ${((paidSec * 0.8) / 60).toFixed(2)} 元`,
      progress: Math.min(100, Math.round((played / total) * 100)),
    });
  },

  async beat() {
    if (!this.session) return;
    try {
      const res = await api.post(`/api/sessions/${this.session.sessionId}/heartbeat`, { playedSeconds: this.played });
      if (res.shouldStop) {
        clearInterval(this.beatTimer);
        util.toast(res.stopReason === 'NEED_MEMBERSHIP' ? '体验额度已用完，已暂停' : '余额不足，已暂停');
        this.onStop(true);
        return;
      }
      if (res.trialSecondsLeft === 0) this.setData({ fundingText: '会员计费中', fundingClass: 'orange' });
    } catch (e) {
      /* 单次心跳失败不影响计时 */
    }
  },

  async onStop(auto) {
    if (!this.session) return;
    clearInterval(this.tickTimer);
    clearInterval(this.beatTimer);
    if (this.audio) this.audio.stop();
    const played = Math.max(1, this.played || Math.floor((Date.now() - this.startedAt) / 1000));
    this.setData({ playing: false, progress: 0, clock: '00:00' });
    try {
      const out = await api.post(`/api/sessions/${this.session.sessionId}/end`, { playedSeconds: played });
      const r = out.receipt;
      this.session = null;
      this.setData({ costText: `本次 ${util.money(r.costFen)} 元` });
      wx.showModal({
        title: '本次听课账单',
        content:
          `收听 ${r.billableSeconds} 秒（体验 ${r.trialSeconds} 秒 / 计费 ${r.paidSeconds} 秒）\n` +
          `扣费 ${util.money(r.costFen)} 元\n` +
          `体验剩余 ${util.mmss(r.wallet.trialSecondsLeft)}\n` +
          `余额 ${util.money(r.wallet.cashFen)} 元` +
          (r.shortfallSeconds > 0 ? `\n有 ${r.shortfallSeconds} 秒因余额不足未计费` : ''),
        showCancel: false,
        confirmText: '好',
      });
    } catch (err) {
      util.toast(err.message);
    }
  },

  handleGate(err) {
    if (err.code === 'NEED_MEMBERSHIP') {
      wx.showModal({
        title: '免费体验已用完',
        content: '60 分钟体验额度已经听完。开通会员后按 0.80 元/分钟计费，听多久算多久。',
        confirmText: '去开通',
        success: (r) => {
          if (r.confirm) wx.switchTab({ url: '/pages/account/account' });
        },
      });
    } else if (err.code === 'NEED_TOPUP') {
      wx.showModal({
        title: '余额不足',
        content: '会员余额不够继续听课了，充值后立即恢复。',
        confirmText: '去充值',
        success: (r) => {
          if (r.confirm) wx.switchTab({ url: '/pages/account/account' });
        },
      });
    } else {
      util.toast(err.message);
    }
  },

  onUnload() {
    clearInterval(this.tickTimer);
    clearInterval(this.beatTimer);
    if (this.audio) this.audio.destroy();
    // 离开页面时兜底结算，避免挂着一节课一直计时
    if (this.session) {
      api
        .post(`/api/sessions/${this.session.sessionId}/end`, { playedSeconds: this.played })
        .catch(() => {});
      this.session = null;
    }
  },
});
