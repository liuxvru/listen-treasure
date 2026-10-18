"""听声鉴宝 · 声音识别器（Python 重写版）

包结构：
  config      —— 路径与可调参数
  library     —— 载入声音库（模板补丁 + 图鉴藏品）
  dsp         —— 降噪 / 特征 / 补丁生成（numpy + scipy）
  matcher     —— 实时模板匹配与确认逻辑
  capture     —— WASAPI 回环与麦克风采集
  engine      —— 文件识别 / 实时识别 / 电平表
  server      —— FastAPI 后端 + SSE 实时事件
  ui          —— 内嵌的网页界面资源（原生 ES module，无构建）
"""

__version__ = "2.0.0"
