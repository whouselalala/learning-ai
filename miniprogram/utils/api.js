const BASE_URL = 'https://learning-api.walankaai.com';

const TOKEN_KEY = 'xs_token';

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || '';
}

function setToken(token) {
  if (token) wx.setStorageSync(TOKEN_KEY, token);
  else wx.removeStorageSync(TOKEN_KEY);
}

function request(method, path, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + path,
      method,
      data: data || {},
      timeout: 90000,
      header: {
        'content-type': 'application/json',
        authorization: getToken() ? `Bearer ${getToken()}` : '',
      },
      success(res) {
        const body = res.data || {};
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
          return;
        }
        const err = new Error((body.error && body.error.message) || `请求失败(${res.statusCode})`);
        err.code = body.error && body.error.code;
        err.status = res.statusCode;
        err.data = body.error;
        if (res.statusCode === 401) {
          setToken('');
          wx.reLaunch({ url: '/pages/index/index' });
        }
        reject(err);
      },
      fail(e) {
        reject(new Error(e.errMsg || '网络异常，请检查后端是否启动'));
      },
    });
  });
}

module.exports = {
  BASE_URL,
  getToken,
  setToken,
  get: (p) => request('GET', p),
  post: (p, d) => request('POST', p, d),
  patch: (p, d) => request('PATCH', p, d),
  del: (p) => request('DELETE', p),
};
