const util = require('../../utils/util.js');
const api = require('../../utils/api.js');
const app = getApp();

Page({
  data: {
    messages: [],
    memories: [],
    text: '',
    sending: false,
    anchor: '',
    wallet: { isMember: false, cashFen: 0, trialSecondsLeft: 0 },
    cashText: '0.00',
    trialText: '00:00',
  },

  onShow() {
    if (!api.getToken()) {
      wx.reLaunch({ url: '/pages/index/index' });
      return;
    }
    if (!this.data.messages.length) this.loadHistory();
    this.refreshMe();
  },

  async loadHistory() {
    try {
      const res = await api.get('/api/chat/history');
      const messages = res.messages.map((m) => ({ id: m.id, role: m.role, content: m.content }));
      if (!messages.length) {
        messages.push({
          id: 'welcome',
          role: 'assistant',
          content:
            '你好，我是小习。先用一两句话告诉我：现在几年级、哪一科最头疼、每天大概能挤出多少时间？我会一边聊一边把你的情况记下来，再给你排一份能听的学习方案。',
        });
      }
      this.setData({ messages }, this.scrollToBottom);
    } catch (err) {
      util.toast(err.message);
    }
  },

  async refreshMe() {
    try {
      const me = await api.get('/api/me');
      app.globalData.user = me.user;
      this.setData({
        memories: me.memories || [],
        wallet: me.wallet,
        cashText: util.money(me.wallet.cashFen),
        trialText: util.mmss(me.wallet.trialSecondsLeft),
      });
    } catch (err) {
      /* 静默失败，不打断对话 */
    }
  },

  onInput(e) {
    this.setData({ text: e.detail.value });
  },

  onSuggest(e) {
    this.setData({ text: e.currentTarget.dataset.text });
    this.onSend();
  },

  scrollToBottom() {
    setTimeout(() => this.setData({ anchor: 'anchor-bottom' }), 60);
  },

  async send(text, wantPlan) {
    const content = String(text || '').trim();
    if (!content || this.data.sending) return;
    const messages = this.data.messages.concat([{ id: 'u' + Date.now(), role: 'user', content }]);
    this.setData({ messages, text: '', sending: true }, this.scrollToBottom);
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });

    try {
      const res = await api.post('/api/chat', { text: content, wantPlan: Boolean(wantPlan) });
      const next = this.data.messages.concat([{ id: 'a' + Date.now(), role: 'assistant', content: res.reply }]);
      this.setData({ messages: next, sending: false }, this.scrollToBottom);
      if (res.plan) {
        wx.showModal({
          title: '方案已生成',
          content: `${res.plan.title}\n共 ${res.plan.weeks} 周，每周 ${res.plan.sessionsPerWeek} 节音频课。`,
          confirmText: '去看看',
          success: (r) => {
            if (r.confirm) wx.switchTab({ url: '/pages/plan/plan' });
          },
        });
      }
      this.refreshMe();
    } catch (err) {
      this.setData({ sending: false });
      util.toast(err.message);
    }
  },

  onSend() {
    this.send(this.data.text, false);
  },

  onWantPlan() {
    if (this.data.sending) return;
    const text = this.data.text.trim() || '帮我按我的情况排一份 4 周的学习方案';
    this.send(text, true);
  },
});
