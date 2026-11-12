const util = require('../../utils/util.js');
const api = require('../../utils/api.js');

Page({
  data: {
    loading: true,
    detail: null,
    generatingWeek: 0,
    doneText: '0 节已完成',
  },

  onShow() {
    if (!api.getToken()) {
      wx.reLaunch({ url: '/pages/index/index' });
      return;
    }
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const res = await api.get('/api/plans');
      if (!res.plans.length) {
        this.setData({ loading: false, detail: null });
        return;
      }
      await this.loadDetail(res.plans[0].id);
    } catch (err) {
      util.toast(err.message);
      this.setData({ loading: false });
    }
  },

  async loadDetail(planId) {
    try {
      const detail = await api.get('/api/plans/' + planId);
      const weeks = detail.weeks.map((w) => ({
        ...w,
        lessons: w.lessons.map((l) => ({ ...l, minutesText: util.minutes(l.durationSec) })),
      }));
      this.setData({
        detail: { ...detail, weeks },
        loading: false,
        doneText: `已完成 ${detail.progress.completedLessons}/${detail.progress.totalLessons || 0} 节`,
      });
    } catch (err) {
      util.toast(err.message);
      this.setData({ loading: false });
    }
  },

  async onGenWeek(e) {
    const week = Number(e.currentTarget.dataset.week);
    if (this.data.generatingWeek) return;
    this.setData({ generatingWeek: week });
    try {
      await api.post(`/api/plans/${this.data.detail.plan.id}/weeks/${week}/lessons`);
      await this.loadDetail(this.data.detail.plan.id);
      util.toast('本周课程已生成');
    } catch (err) {
      util.toast(err.message);
    } finally {
      this.setData({ generatingWeek: 0 });
    }
  },

  onPlay(e) {
    const lessonId = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/player/player?lessonId=${lessonId}` });
  },

  goChat() {
    wx.switchTab({ url: '/pages/chat/chat' });
  },

  onReplan() {
    wx.showModal({
      title: '重排方案',
      content: '会按最新的学习记录和记忆重新生成一份方案，原来的方案会保留。',
      confirmText: '重排',
      success: async (r) => {
        if (!r.confirm) return;
        wx.showLoading({ title: '正在重排…' });
        try {
          const out = await api.post('/api/plans', { goal: '按最新情况重排 4 周方案', weeks: 4 });
          await this.loadDetail(out.plan.id);
          util.toast('方案已重排');
        } catch (err) {
          util.toast(err.message);
        } finally {
          wx.hideLoading();
        }
      },
    });
  },
});
