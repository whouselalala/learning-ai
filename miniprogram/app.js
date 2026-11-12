const api = require('./utils/api.js');

App({
  globalData: {
    token: '',
    user: null,
    config: null,
    inviteCode: '',
  },

  onLaunch() {
    this.globalData.token = api.getToken();
    api
      .get('/api/config')
      .then((res) => {
        this.globalData.config = res;
      })
      .catch(() => {});
  },

  /** 静默登录：wx.login 换 code，交给后端换 openid 并签发 token */
  login(profile = {}) {
    return new Promise((resolve, reject) => {
      wx.login({
        success: async ({ code }) => {
          try {
            const res = await api.post('/api/auth/login', {
              code,
              nickname: profile.nickname || '',
              avatar: profile.avatar || '',
              inviteCode: profile.inviteCode || this.globalData.inviteCode || '',
            });
            api.setToken(res.token);
            this.globalData.token = res.token;
            this.globalData.user = res.user;
            resolve(res);
          } catch (err) {
            reject(err);
          }
        },
        fail: reject,
      });
    });
  },
});
