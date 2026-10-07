/*!
 * Hackathon 组队雷达 —— 演示数据（前后端共用）
 * ---------------------------------------------------------------
 * 这份文件被两边加载：
 *   1. 浏览器：静态部署时点「载入演示数据」，往本机匹配池里塞人
 *   2. Node：scripts/seed.js 通过 HTTP 接口写进服务端
 * 放一份是为了不让两边各维护一套假数据，改了这里两边都变。
 *
 * 这 8 个人的资料是刻意配过的：有技能互补的、有共同兴趣的、有角色正好对上的，
 * 也有两个几乎没交集的（用来验证「智能互补」确实会避开烂组合）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HackathonDemoPeople = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PEOPLE = [
    {
      name: '林可', avatar: 'avatar-01', tagline: '把动效做得让人想多点两下',
      skills: [{ name: '前端', level: 'pro' }, { name: 'JavaScript', level: 'pro' }, { name: '3D 建模', level: 'learn' }],
      interests: ['独立游戏', '摄影'], lookingFor: ['UI 设计'], contact: 'wx: linke'
    },
    {
      name: '陈墨', avatar: 'avatar-02', tagline: '做界面也做海报，能熬夜',
      skills: [{ name: 'UI 设计', level: 'pro' }, { name: '视频剪辑', level: 'know' }, { name: '前端', level: 'learn' }],
      interests: ['独立游戏', '咖啡'], lookingFor: ['前端'], contact: 'wx: chenmo'
    },
    {
      name: '赵一鸣', avatar: 'avatar-03', tagline: '想把大模型塞进一个具体的小场景',
      skills: [{ name: 'Python', level: 'pro' }, { name: '大模型应用', level: 'pro' }, { name: '后端', level: 'know' }],
      interests: ['AI 应用', '开源'], lookingFor: ['前端'], contact: 'wx: zhaoym'
    },
    {
      name: '苏晴', avatar: 'avatar-04', tagline: '负责把想法砍到能做完',
      skills: [{ name: '产品经理', level: 'pro' }, { name: '数据分析', level: 'know' }, { name: '演讲/PPT', level: 'pro' }],
      interests: ['创业', '读书'], lookingFor: ['后端'], contact: 'wx: suqing'
    },
    {
      name: '郑野', avatar: 'avatar-05', tagline: '焊过板子，也写过驱动',
      skills: [{ name: '硬件/嵌入式', level: 'pro' }, { name: 'Python', level: 'know' }, { name: '算法', level: 'learn' }],
      interests: ['硬件折腾', '攀岩'], lookingFor: ['算法'], contact: 'wx: zhengye'
    },
    {
      name: '何嘉', avatar: 'avatar-06', tagline: '模型调得比人准一点',
      skills: [{ name: '算法', level: 'pro' }, { name: 'Python', level: 'pro' }, { name: '硬件/嵌入式', level: 'learn' }],
      interests: ['AI 应用', '跑步'], lookingFor: ['硬件/嵌入式'], contact: 'wx: hejia'
    },
    {
      name: '吴晓', avatar: 'avatar-07', tagline: '剪片子的人，也写点前端',
      skills: [{ name: '视频剪辑', level: 'pro' }, { name: '前端', level: 'know' }, { name: '运营', level: 'know' }],
      interests: ['摄影', '二次元'], lookingFor: ['产品经理'], contact: 'wx: wuxiao'
    },
    {
      name: '周牧', avatar: 'avatar-08', tagline: '服务别挂就行',
      skills: [{ name: '后端', level: 'pro' }, { name: '运维/部署', level: 'pro' }, { name: '数据分析', level: 'know' }],
      interests: ['开源', '桌游'], lookingFor: ['UI 设计'], contact: 'wx: zhoumu'
    }
  ];

  return { people: PEOPLE };
});
