const util = require('../../utils/util.js');
const api = require('../../utils/api.js');
const app = getApp();

const LEDGER_LABEL = {
  topup: '充值',
  consume: '听课扣费',
  trial: '体验课',
  commission: '佣金结算',
  withdraw: '佣金提现',
  refund: '退款',
  adjust: '调整',
};

Page({
  data: {
    user: {},
    initial: '习',
    isMember: false,
    priceText: '0.80 元/分钟',
    cashText: '0.00',
    commText: '0.00',
    spentText: '0.00',
    trialText: '00:00',
    trialPercent: 0,
    pendingText: '0.00',
    settledText: '0.00',
    directCount: 0,
    qualifiedCount: 0,
    qualifyText: '50.00',
    members: [],
    r1Text: '',
    r2Text: '',
    r3Text: '',
    memories: [],
    ledger: [],
    referral: {},
  },

  onShow() {
    if (!api.getToken()) {
      wx.reLaunch({ url: '/pages/index/index' });
      return;
    }
    this.loadAll();
  },

  async loadAll() {
    try {
      const [me, ledger, referral] = await Promise.all([
        api.get('/api/me'),
        api.get('/api/me/ledger'),
        api.get('/api/referral'),
      ]);
      const w = me.wallet;
      app.globalData.user = me.user;
      this.setData({
        user: me.user,
        initial: (me.user.nickname || '习').slice(0, 1),
        isMember: w.isMember,
        priceText: `${(w.priceFenPerMinute / 100).toFixed(2)} 元/分钟`,
        cashText: util.money(w.cashFen),
        commText: util.money(w.commissionFen),
        spentText: util.money(w.totalSpentFen),
        trialText: `${util.mmss(w.trialSecondsLeft)} / ${util.mmss(w.trialSeconds)}`,
        trialPercent: Math.round((w.trialSecondsLeft / w.trialSeconds) * 100),
        memories: me.memories || [],
        ledger: ledger.items.map((i) => ({
          id: i.id,
          label: LEDGER_LABEL[i.kind] || i.kind,
          memo: i.memo || '',
          timeText: util.dateLabel(i.createdAt),
          amountText: i.amountFen === 0 ? '—' : (i.amountFen > 0 ? '+' : '') + util.money(i.amountFen),
          plus: i.amountFen > 0,
        })),
        referral,
        directCount: referral.directCount || 0,
        qualifiedCount: referral.qualifiedCount || 0,
        qualifyText: util.money(referral.qualifyFen || 0),
        members: (referral.members || []).map((m) => ({
          ...m,
          paidText: util.money(m.cumulativeFen),
          earnedText: util.money(m.pendingFen + m.settledFen),
        })),
        pendingText: util.money(referral.pendingFen),
        settledText: util.money(referral.settledFen),
        r1Text: this.rateText(referral, 0),
        r2Text: this.rateText(referral, 1),
        r3Text: this.rateText(referral, 2),
      });
    } catch (err) {
      util.toast(err.message);
    }
  },

  rateText(referral, i) {
    const d = (referral.byRate || [])[i];
    if (!d) return '';
    return `${d.memberCount} 人 · ${util.money(d.pendingFen + d.settledFen)} 元`;
  },

  async onActivate() {
    try {
      await api.post('/api/membership/activate', {});
      await this.loadAll();
      wx.showModal({
        title: '已开通会员',
        content: '现在按 0.80 元/分钟计费，听多久算多久。记得先充值，余额不足会暂停计费。',
        showCancel: false,
      });
    } catch (err) {
      util.toast(err.message);
    }
  },

  onTopup() {
    const amounts = [1000, 2000, 5000, 10000];
    wx.showActionSheet({
      itemList: ['10 元', '20 元', '50 元', '100 元'],
      success: (r) => this.pay(amounts[r.tapIndex]),
    });
  },

  /** 下单 → 拉起微信支付（或演示通道）→ 轮询确认 */
  async pay(amountFen) {
    wx.showLoading({ title: '正在下单…', mask: true });
    try {
      const created = await api.post('/api/pay/order', { amountFen });
      const params = created.payParams || {};

      if (params.provider === 'wechat') {
        wx.hideLoading();
        await new Promise((resolve, reject) => {
          wx.requestPayment({
            timeStamp: params.timeStamp,
            nonceStr: params.nonceStr,
            package: params.package,
            signType: params.signType,
            paySign: params.paySign,
            success: resolve,
            fail: reject,
          });
        });
        wx.showLoading({ title: '确认支付…', mask: true });
        let paid = false;
        for (let i = 0; i < 10; i += 1) {
          const q = await api.get('/api/pay/orders/' + created.order.id);
          if (q.order.status === 'paid') {
            paid = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 800));
        }
        await this.loadAll();
        wx.hideLoading();
        util.toast(paid ? '支付成功' : '支付结果确认中，稍后刷新');
        return;
      }

      // 演示通道：模拟支付成功
      await api.post('/api/pay/mock-pay', { orderId: created.order.id });
      await this.loadAll();
      wx.hideLoading();
      wx.showToast({ title: '充值成功', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      const msg = String(err.errMsg || err.message || '');
      if (msg.indexOf('cancel') >= 0) {
        util.toast('已取消支付');
        return;
      }
      util.toast(msg || '支付失败');
    }
  },

  onWithdraw() {
    const amount = Math.floor((this.data.referral.wallet || {}).commissionFen || 0);
    if (amount < 1000) {
      util.toast('可提现佣金不足 10 元');
      return;
    }
    wx.showModal({
      title: '提现佣金',
      content: `可提现 ${util.money(amount)} 元，提交后 1 到 3 个工作日到账（演示环境不实际打款）。`,
      confirmText: '提交',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await api.post('/api/billing/withdraw', { amountFen: amount });
          await this.loadAll();
          util.toast('提现申请已提交');
        } catch (err) {
          util.toast(err.message);
        }
      },
    });
  },

  onCopyCode() {
    wx.setClipboardData({
      data: this.data.user.inviteCode || '',
      success: () => util.toast('邀请码已复制'),
    });
  },

  onDelMemory(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除记忆',
      content: '删除后小习不会再参考这条信息，确定吗？',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await api.del('/api/me/memories/' + id);
          await this.loadAll();
          util.toast('已删除');
        } catch (err) {
          util.toast(err.message);
        }
      },
    });
  },
});
