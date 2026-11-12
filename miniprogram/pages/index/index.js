const app = getApp();
const util = require('../../utils/util.js');
const api = require('../../utils/api.js');

Page({
  data: {
    nickname: '',
    inviteCode: '',
    loading: false,
  },

  onLoad(options) {
    if (options.inviteCode) {
      this.setData({ inviteCode: String(options.inviteCode).toUpperCase() });
      app.globalData.inviteCode = options.inviteCode;
    }
    if (api.getToken()) {
      wx.switchTab({ url: '/pages/chat/chat' });
    }
  },

  onNick(e) {
    this.setData({ nickname: e.detail.value });
  },

  onInvite(e) {
    this.setData({ inviteCode: e.detail.value.toUpperCase() });
  },

  async onLogin() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const res = await app.login({
        nickname: this.data.nickname || '新同学',
        inviteCode: this.data.inviteCode.trim(),
      });
      if (res.referralError) util.toast(res.referralError);
      wx.switchTab({ url: '/pages/chat/chat' });
    } catch (err) {
      util.toast(err.message);
    } finally {
      this.setData({ loading: false });
    }
  },
});
