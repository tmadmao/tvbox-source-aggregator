import { sharedStyles } from './shared-styles';
import { sharedUi } from './shared-ui';

export const adminHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TVBox Aggregator - Admin</title>
<style>
${sharedStyles}

/* Admin-specific: action bar in header */
.agg-bar{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  margin-top:16px;
  padding:12px 16px;
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:6px;
  font-family:var(--mono);
  font-size:0.75rem;
  color:var(--text-dim);
}

.agg-bar .status-text{font-family:var(--mono);font-size:0.75rem;color:var(--text-dim)}
.agg-bar .status-text.success{color:var(--green)}
.agg-bar .status-text.error{color:var(--red)}

/* Inline form label */
.form-label{
  font-family:var(--mono);
  font-size:0.65rem;
  color:var(--text-dim);
  text-transform:uppercase;
  letter-spacing:0.1em;
  display:block;
  margin-bottom:4px;
}

/* Name transform grid */
.nt-grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:10px;
  margin-bottom:10px;
}

.nt-input{
  width:100%;
  font-family:var(--mono);
  font-size:0.8rem;
  padding:8px 12px;
  background:var(--bg);
  border:1px solid var(--border);
  border-radius:4px;
  color:var(--text-bright);
  outline:none;
  transition:border-color 0.2s;
}

.nt-input:focus{border-color:var(--green)}

.nt-textarea{
  width:100%;
  min-height:60px;
  font-family:var(--mono);
  font-size:0.75rem;
  padding:8px 12px;
  background:var(--bg);
  border:1px solid var(--border);
  border-radius:4px;
  color:var(--text-bright);
  resize:vertical;
  outline:none;
}

.nt-textarea:focus{border-color:var(--green)}

/* Cloud login cards */
.cloud-card{
  padding:12px;
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:6px;
  display:flex;
  flex-direction:column;
  gap:8px;
}
.cloud-card-header{
  display:flex;
  justify-content:space-between;
  align-items:center;
}
.cloud-card-name{
  font-weight:600;
  font-size:0.9rem;
  color:var(--text-bright);
}
.cloud-badge{
  font-family:var(--mono);
  font-size:0.65rem;
  padding:2px 8px;
  border-radius:10px;
  text-transform:uppercase;
  letter-spacing:0.05em;
}
.cloud-badge.valid{background:rgba(80,250,123,0.15);color:var(--green)}
.cloud-badge.expired{background:rgba(255,85,85,0.15);color:var(--red)}
.cloud-badge.none{background:rgba(136,136,136,0.15);color:var(--text-dim)}
.cloud-card-actions{display:flex;gap:6px;flex-wrap:wrap}
.cloud-card-time{font-family:var(--mono);font-size:0.7rem;color:var(--text-dim)}

/* Risk badges */
.risk-badge{
  font-family:var(--mono);
  font-size:0.7rem;
  padding:1px 6px;
  border-radius:8px;
}
.risk-badge.safe{background:rgba(80,250,123,0.15);color:var(--green)}
.risk-badge.low{background:rgba(80,250,123,0.1);color:var(--green)}
.risk-badge.high{background:rgba(255,85,85,0.15);color:var(--red)}
.risk-badge.unaudited{background:rgba(241,250,140,0.15);color:var(--yellow)}

/* QR modal */
.qr-modal-overlay{
  position:fixed;top:0;left:0;right:0;bottom:0;
  background:rgba(0,0,0,0.7);
  display:flex;align-items:center;justify-content:center;
  z-index:1000;
}
.qr-modal{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:8px;
  padding:24px;
  min-width:300px;
  max-width:400px;
  text-align:center;
}
.qr-modal h3{margin:0 0 16px;color:var(--text-bright);font-size:1rem}
.qr-modal img{
  max-width:250px;
  max-height:250px;
  border-radius:4px;
  background:#fff;
  padding:8px;
}
.qr-status{
  margin-top:12px;
  font-family:var(--mono);
  font-size:0.8rem;
  color:var(--text-dim);
}
.qr-status.scanned{color:var(--yellow)}
.qr-status.confirmed{color:var(--green)}
.qr-status.expired{color:var(--red)}

/* Import textarea */
.import-textarea{
  width:100%;
  min-height:100px;
  font-family:var(--mono);
  font-size:0.75rem;
  padding:10px;
  background:var(--bg);
  border:1px solid var(--border);
  border-radius:4px;
  color:var(--text-bright);
  resize:vertical;
  margin-bottom:8px;
}

/* Batch textarea */
.batch-textarea{
  width:100%;
  margin-top:8px;
  min-height:120px;
  font-family:var(--mono);
  font-size:0.75rem;
  padding:10px;
  background:var(--bg);
  border:1px solid var(--border);
  border-radius:4px;
  color:var(--text-bright);
  resize:vertical;
}

/* Source health dot in list items */
.source-health-dot{
  width:8px;height:8px;
  border-radius:50%;
  flex-shrink:0;
  position:relative;
  cursor:default;
}

.source-health-dot.ok{
  background:var(--green);
  box-shadow:0 0 4px var(--green-glow);
}

.source-health-dot.warn{
  background:var(--amber);
  box-shadow:0 0 4px var(--amber-dim);
}

.source-health-dot.error{
  background:var(--red);
  box-shadow:0 0 4px var(--red-dim);
}

.source-health-dot.unknown{
  background:var(--text-dim);
}

.source-health-dot::after{
  content:attr(data-tooltip);
  position:absolute;
  left:50%;
  bottom:calc(100% + 8px);
  transform:translateX(-50%);
  padding:6px 10px;
  background:var(--surface-2);
  border:1px solid var(--border);
  border-radius:4px;
  font-family:var(--mono);
  font-size:0.6rem;
  color:var(--text);
  white-space:nowrap;
  pointer-events:none;
  opacity:0;
  transition:opacity 0.2s;
  z-index:10;
}

.source-health-dot:hover::after{
  opacity:1;
}

@media(max-width:560px){
  .nt-grid{grid-template-columns:1fr}
  .tabs{overflow-x:auto;flex-wrap:nowrap}
  .tab{padding:12px 14px;font-size:0.65rem}
}
</style>
<script>(function(){var t=localStorage.getItem('theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
</head>
<body style="opacity:0">

<!-- Login -->
<div class="login-overlay" id="loginOverlay">
  <div class="login-box">
    <h2 data-i18n="loginTitle">Admin Access</h2>
    <p data-i18n="loginSubtitle">TVBox Aggregator Management</p>
    <div class="error-msg" id="loginError" data-i18n="invalidToken">Invalid token</div>
    <input type="password" id="loginInput" placeholder="Enter admin token" data-i18n-placeholder="enterToken" autocomplete="off">
    <button class="btn" style="width:100%" onclick="auth.doLogin()" data-i18n="login">Login</button>
  </div>
</div>

<!-- Main content -->
<div class="container" id="mainContent" style="display:none">
  <header class="header">
    <div class="header-top">
      <div class="header-label" data-i18n="headerLabel">Admin Console</div>
      <div style="display:flex;gap:8px;align-items:center">
        <span id="themeDropdown"></span>
        <button class="lang-toggle" id="langToggle" onclick="doToggleLang()">中文</button>
      </div>
    </div>
    <h1 class="header-title">Source <span>Manager</span></h1>
    <nav class="header-nav">
      <a href="/admin/config-editor" data-i18n="navConfigEditor">Config Editor</a>
      <a href="/builder">Builder</a>
      <a href="/status" data-i18n="navDashboard">Dashboard</a>
    </nav>
    <!-- Aggregation status bar -->
    <div class="agg-bar">
      <span class="status-text" id="aggStatus" data-i18n="loadingStatus">Loading...</span>
      <button class="btn btn-sm" id="refreshBtn" onclick="triggerRefresh()" data-i18n="refresh">Refresh</button>
    </div>
  </header>

  <!-- Tabs -->
  <div class="tabs">
    <div class="tab active" data-tab="sources" onclick="switchTab('sources')"><span data-i18n="tabSources">Sources</span> <span class="badge" id="badgeSources">0</span></div>
    <div class="tab" data-tab="health" onclick="switchTab('health')"><span data-i18n="tabHealth">源健康</span></div>
    <div class="tab" data-tab="live" onclick="switchTab('live')"><span data-i18n="tabLive">Live</span> <span class="badge" id="badgeLive">0</span></div>
    <div class="tab" data-tab="searchQuota" onclick="switchTab('searchQuota')" id="tabSearchQuota" style="display:none"><span data-i18n="tabSearchQuota">Search</span> <span class="badge" id="badgeSearchQuota">0</span></div>
    <div class="tab" data-tab="channels" onclick="switchTab('channels')"><span data-i18n="tabChannels">频道</span> <span class="badge" id="badgeChannels">0</span></div>
    <div class="tab" data-tab="cloud" onclick="switchTab('cloud')"><span data-i18n="tabCloud">Cloud</span></div>
    <div class="tab" data-tab="settings" onclick="switchTab('settings')"><span data-i18n="tabSettings">Settings</span></div>
    <div class="tab" data-tab="aggLogs" onclick="switchTab('aggLogs')"><span data-i18n="tabAggLogs">Logs</span></div>
  </div>

  <!-- Sources Tab -->
  <div class="tab-panel active" id="panelSources">
    <!-- Add source -->
    <div class="section">
      <div class="section-title" data-i18n="addSource">Add Source</div>
      <div class="add-form">
        <input class="name-input" type="text" id="addName" placeholder="Name (optional)" data-i18n-placeholder="nameOptional">
        <input type="url" id="addUrl" placeholder="TVBox config JSON URL" data-i18n-placeholder="configJsonUrl">
        <input class="name-input" type="text" id="addConfigKey" placeholder="Config Key (optional, for AES ECB)">
        <button class="btn" id="addBtn" onclick="addSource()" data-i18n="add">Add</button>
      </div>
      <!-- Import (collapsible) -->
      <div class="collapsible-toggle" onclick="toggleCollapsible(this)" data-i18n="importConfig">Import Config</div>
      <div class="collapsible-body">
        <textarea id="importInput" class="import-textarea" placeholder="Paste TVBox JSON or URL here..." data-i18n-placeholder="importPlaceholder"></textarea>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-sm" id="importBtn" onclick="importConfig()" data-i18n="import">Import</button>
          <span class="status-text" id="importResult" style="font-family:var(--mono);font-size:0.75rem"></span>
        </div>
      </div>
    </div>

    <!-- Source list -->
    <div class="section">
      <div class="section-title">
        <span data-i18n="sourcesList">Sources</span>
        <span class="count" id="sourceCount">0</span>
      </div>
      <div class="source-list" id="sourceList">
        <div class="empty">Loading sources...</div>
      </div>
    </div>
  </div>

  <!-- MacCMS Tab -->
  <div class="tab-panel" id="panelMaccms">
    <!-- Add MacCMS -->
    <div class="section">
      <div class="section-title" data-i18n="addMacCMS">Add MacCMS Source</div>
      <div class="add-form">
        <input class="name-input" type="text" id="mcKey" placeholder="Key (e.g. hongniuzy)" data-i18n-placeholder="mcKeyPh">
        <input class="name-input" type="text" id="mcName" placeholder="Name" data-i18n-placeholder="mcNamePh">
        <input type="url" id="mcApi" placeholder="MacCMS API URL" data-i18n-placeholder="mcApiPh">
        <button class="btn" id="mcAddBtn" onclick="addMacCMS()" data-i18n="add">Add</button>
      </div>
      <!-- Batch import (collapsible) -->
      <div class="collapsible-toggle" onclick="toggleCollapsible(this)" data-i18n="batchImport">Batch Import</div>
      <div class="collapsible-body">
        <textarea id="mcBatchInput" class="batch-textarea" placeholder='[{"key":"...","name":"...","api":"..."}]'></textarea>
        <button class="btn btn-sm" style="margin-top:8px" id="mcBatchBtn" onclick="batchImportMacCMS()" data-i18n="submitBatch">Submit Batch</button>
      </div>
    </div>

    <!-- MacCMS list -->
    <div class="section">
      <div class="section-title">
        <span data-i18n="macCMSSources">MacCMS Sources</span>
        <span class="count" id="mcCount">0</span>
      </div>
      <div class="source-list" id="mcList">
        <div class="empty">Loading MacCMS sources...</div>
      </div>
    </div>
  </div>

  <!-- Live Tab -->
  <div class="tab-panel" id="panelLive">
    <!-- Add live source -->
    <div class="section">
      <div class="section-title" data-i18n="addLiveSource">Add Live Source</div>
      <div class="add-form">
        <input class="name-input" type="text" id="liveName" placeholder="Name (e.g. iptv365)" data-i18n-placeholder="liveNamePh">
        <input type="url" id="liveUrl" placeholder="m3u/txt URL" data-i18n-placeholder="liveUrlPh">
        <button class="btn" id="liveAddBtn" onclick="addLive()" data-i18n="add">Add</button>
      </div>
    </div>

    <!-- Live list -->
    <div class="section">
      <div class="section-title">
        <span data-i18n="liveSources">Live Sources</span>
        <span class="count" id="liveCount">0</span>
      </div>
      <div class="source-list" id="liveList">
        <div class="empty">Loading live sources...</div>
      </div>
    </div>

    <!-- Channel Probe (Node/Docker only) -->
    <div class="section" id="channelProbeSection">
      <div class="section-title" data-i18n="channelProbeTitle">Channel Speed Probe (Node/Docker)</div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="channelProbeCheck" onchange="toggleChannelProbe()">
          <span data-i18n="channelProbeEnable">Enable scheduled channel speed test (every 2h)</span>
        </label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="probeInlineCheck" onchange="saveProbeInline()">
          <span data-i18n="probeInlineLabel">测速并入聚合流程（不再单独定时跑）</span>
        </label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="probeSegmentCheck" onchange="saveProbeSegment()">
          <span data-i18n="probeSegmentLabel">分片复验（拉一小段视频确认真能播）</span>
        </label>
        <button class="btn btn-sm" onclick="clearProbeCache()" data-i18n="probeClearCache">清空测速缓存</button>
        <button class="btn btn-sm" id="channelProbeTriggerBtn" onclick="triggerChannelProbe()" data-i18n="channelProbeTrigger">Run Now</button>
        <button class="btn btn-sm" onclick="loadChannelProbe()" data-i18n="refresh">Refresh</button>
        <button class="btn btn-sm btn-danger" id="channelProbeDropBtn" onclick="dropDeadSources()" data-i18n="channelProbeDropDead">Clean Dead Sources</button>
        <button class="btn btn-sm" id="channelProbeRestoreBtn" style="display:none" onclick="restoreDeadSources()" data-i18n="channelProbeRestoreDead">Restore</button>
      </div>
      <div id="channelProbeStatus" style="font-size:0.85rem;color:var(--text-secondary);line-height:1.6"></div>
    </div>

    <!-- Live Disable Toggle -->
    <div class="section">
      <div class="section-title" data-i18n="liveToggleTitle">Live Feature Toggle</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="liveDisabledCheck" onchange="saveLiveDisabled()">
          <span data-i18n="liveToggleLabel">Disable live aggregation (skip live merge, output empty lives)</span>
        </label>
        <span class="status-text" id="liveDisabledStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
    </div>

    <!-- Live Merge Mode -->
    <div class="section">
      <div class="section-title">直播合并模式</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button id="liveMergeSeparated" class="btn btn-sm active" onclick="setLiveMergeMode('separated')">📂 分离模式（按源分类）</button>
        <button id="liveMergeMerged" class="btn btn-sm" onclick="setLiveMergeMode('merged')">🔀 合并模式（去重混合）</button>
        <span class="status-text" id="liveMergeModeStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div style="font-size:0.75rem;color:var(--text-secondary);margin-top:4px">
        分离模式：每个直播源独立展示，用「源名」前缀区分。合并模式：所有源的频道按名称去重合并为统一列表。
      </div>
    </div>

    <!-- Live Group Merge -->
    <div class="section" id="liveGroupMergeSection">
      <div class="section-title" data-i18n="groupMergeTitle">分组归并</div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="groupMergeEnabled" onchange="saveLiveGroups()">
          <span data-i18n="groupMergeEnable">启用分组归并（把各源的杂组收进标准分组）</span>
        </label>
        <button class="btn btn-sm" onclick="saveLiveGroups()" data-i18n="channelOrderSave">保存排序</button>
        <button class="btn btn-sm" onclick="resetLiveGroups()" data-i18n="groupMergeReset">恢复默认规则</button>
        <span class="status-text" id="groupMergeStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:6px" data-i18n="groupMergeHint">
        每行一条「关键词=目标分组」，按顺序匹配，认不出的归入「其他」。只影响分组归属，不影响频道合并与测速排序。
      </div>
      <textarea id="groupMergeRules" spellcheck="false" style="width:100%;height:170px;font-family:var(--mono);font-size:0.78rem;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);color:var(--text-primary);resize:vertical"></textarea>
    </div>

    <!-- Live Channel Filter -->
    <div class="section" id="liveFilterSection">
      <div class="section-title" data-i18n="liveFilterTitle">频道过滤</div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="shoppingFilterCheck" onchange="saveShoppingFilter()">
          <span data-i18n="shoppingFilterLabel">自动删除购物/推广频道</span>
        </label>
        <button class="btn btn-sm" onclick="saveShoppingFilter()" data-i18n="channelOrderSave">保存排序</button>
        <span class="status-text" id="shoppingFilterStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:6px" data-i18n="shoppingFilterHint">
        命中任一关键词的频道会被直接剔除（不参与合并与测速）。逗号分隔，注意别用「精选」这类会误伤音乐合辑的词。
      </div>
      <input id="shoppingKeywords" type="text" spellcheck="false"
        style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);color:var(--text-primary);font-size:0.8rem">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="useConfigLivesCheck" onchange="saveUseConfigLives()">
          <span data-i18n="useConfigLivesLabel">采用配置源自带的直播源（默认关闭，开了会掺入大量非电视条目）</span>
        </label>
        <span class="status-text" id="useConfigLivesStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
    </div>

  </div>

  <!-- Channels Tab -->
  <div class="tab-panel" id="panelChannels">
    <div class="section">
      <div class="section-title" data-i18n="channelsTitle">频道与源</div>
      <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:8px" data-i18n="channelsCurationHint">
        央视 / 卫视 / 南京地方台已按编排自动排序；「置顶」把频道提到组首，「禁用」从输出里移除（可撤销）。
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem">
          <span data-i18n="channelsTopN">每台保留</span>
          <input id="topNInput" type="number" min="1" max="20" value="6" style="width:64px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary)">
          <span data-i18n="channelsTopNUnit">条源</span>
        </label>
        <button class="btn btn-sm btn-primary" onclick="optimizeChannels()" data-i18n="channelsOptimize">一键选优</button>
        <button class="btn btn-sm" onclick="loadChannels()" data-i18n="refresh">刷新</button>
        <span class="status-text" id="channelsStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div id="channelSummary" style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:8px"></div>
      <div style="display:flex;gap:12px;align-items:stretch;flex-wrap:wrap">
        <div id="channelGroupList" style="flex:0 0 160px;max-height:420px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:6px"></div>
        <div style="flex:1;min-width:320px;max-height:420px;overflow:auto;border:1px solid var(--border);border-radius:8px">
          <div id="channelTable"></div>
        </div>
      </div>
    </div>
    <!-- Quality guarantee -->
    <div class="section" id="qualitySection">
      <div class="section-title">源质量保障（央视 → 卫视 → 重点地方台）</div>
      <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:8px">
        「保量」不再是每台 8 条，而是每台 N 条<b>本轮实测能播、延迟低于 5 秒超时、不同域名</b>的源。
        死链不再占位置；前排不够时从完整源池继续补测，补不到的进下面的缺口表。
        达标率按频道目录统计（包含因全死被隐藏的台）；缺口表只列央视/卫视与有 2 条以上候选的地方台。
      </div>
      <div id="qualitySummary" style="display:flex;gap:18px;flex-wrap:wrap;font-size:0.82rem;margin-bottom:8px"></div>
      <label style="display:flex;align-items:center;gap:8px;font-size:0.82rem;margin-bottom:8px">
        <input type="checkbox" id="qualityEnabled" onchange="saveQualityToggle()">
        <span>启用输出前补测（关闭后只按上一轮测速结果排序）</span>
        <span class="status-text" id="qualityStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </label>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px;font-size:0.82rem">
        <label style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="guardEnabled" onchange="saveGuardToggle()">
          <span>全自动守夜（每小时重验重点台头部源，缺源自动补测并发布）</span>
        </label>
        <button class="btn btn-sm" onclick="runGuardNow()">立即自检</button>
        <span class="status-text" id="guardStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div id="guardReport" style="font-size:0.78rem;color:var(--text-secondary);margin-bottom:8px"></div>
      <div id="qualityGaps" style="max-height:300px;overflow:auto"></div>
    </div>

    <!-- Curation rules -->
    <div class="section" id="curationRulesSection">
      <div class="section-title">编排规则（改顺序不用发版）</div>
      <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:8px">
        一行一个台名，顺序即电视上的顺序。保存后<b>下一次聚合</b>生效；重启不丢。
        付费台与海外台默认删除，<b>CCTV5+ 例外保留</b>；想恢复某个台，从对应名单里删掉即可。
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <div style="font-size:0.78rem;margin-bottom:4px">央视台序</div>
          <textarea id="ruleCctv" class="import-textarea" style="min-height:130px;font-size:0.72rem"></textarea>
        </div>
        <div>
          <div style="font-size:0.78rem;margin-bottom:4px">卫视台序</div>
          <textarea id="ruleSat" class="import-textarea" style="min-height:130px;font-size:0.72rem"></textarea>
        </div>
        <div>
          <div style="font-size:0.78rem;margin-bottom:4px">南京 / 重点地方台置顶</div>
          <textarea id="ruleNj" class="import-textarea" style="min-height:100px;font-size:0.72rem"></textarea>
        </div>
        <div>
          <div style="font-size:0.78rem;margin-bottom:4px">省份先后</div>
          <textarea id="ruleProvince" class="import-textarea" style="min-height:100px;font-size:0.72rem"></textarea>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px">
        <div>
          <label style="display:flex;align-items:center;gap:6px;font-size:0.8rem;margin-bottom:4px">
            <input type="checkbox" id="excludePaid"><span>删除付费频道</span>
          </label>
          <textarea id="rulePaid" class="import-textarea" style="min-height:84px;font-size:0.72rem" placeholder="一行一个付费频道名"></textarea>
          <textarea id="ruleNiche" class="import-textarea" style="min-height:40px;font-size:0.72rem;margin-top:4px" placeholder="无用画质关键词，如 4K / 8K"></textarea>
        </div>
        <div>
          <label style="display:flex;align-items:center;gap:6px;font-size:0.8rem;margin-bottom:4px">
            <input type="checkbox" id="excludeOverseas"><span>删除海外频道</span>
          </label>
          <textarea id="ruleOverseasGroups" class="import-textarea" style="min-height:52px;font-size:0.72rem" placeholder="整组删除的分组，一行一个"></textarea>
          <textarea id="ruleOverseasKeywords" class="import-textarea" style="min-height:52px;font-size:0.72rem;margin-top:4px" placeholder="名称包含即删除，一行一个"></textarea>
        </div>
      </div>
      <div style="margin-top:6px">
        <div style="font-size:0.78rem;margin-bottom:4px">例外保留（优先于上面的删除）</div>
        <textarea id="ruleKeep" class="import-textarea" style="min-height:44px;font-size:0.72rem" placeholder="一行一个，例如 CCTV5+"></textarea>
      </div>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-top:10px;font-size:0.8rem">
        <label>每台保留 <input id="ruleFocusSources" type="number" min="1" max="20" style="width:56px;padding:3px 5px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary)"> 条</label>
        <label>央视保底 <input id="quotaCctv" type="number" min="0" max="20" style="width:52px;padding:3px 5px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary)"></label>
        <label>卫视保底 <input id="quotaSatellite" type="number" min="0" max="20" style="width:52px;padding:3px 5px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary)"></label>
        <label>地方台保底 <input id="quotaLocal" type="number" min="0" max="20" style="width:52px;padding:3px 5px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary)"></label>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
        <button class="btn btn-sm btn-primary" onclick="saveCurationRules()">保存规则</button>
        <button class="btn btn-sm" onclick="resetCurationRules()">恢复默认</button>
        <span class="status-text" id="curationStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
    </div>

    <!-- Channel Order -->
    <div class="section" id="channelOrderSection">
      <div class="section-title" data-i18n="channelOrderTitle">频道排序</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <button class="btn btn-sm btn-primary" onclick="smartSortChannels()" data-i18n="channelOrderSmart">一键智能排序（央视）</button>
        <button class="btn btn-sm" onclick="saveChannelOrder()" data-i18n="channelOrderSave">保存排序</button>
        <button class="btn btn-sm" onclick="resetChannelOrder()" data-i18n="channelOrderReset">恢复默认</button>
        <span class="status-text" id="channelOrderStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div style="display:flex;gap:12px;align-items:stretch;flex-wrap:wrap">
        <div id="channelOrderGroups" style="flex:0 0 160px;max-height:420px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:6px"></div>
        <div style="flex:1;min-width:280px">
          <div id="channelOrderHint" style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:6px" data-i18n="channelOrderHint">
            拖动频道调整顺序，第一位就是电视上显示的第一个。
          </div>
          <div id="channelOrderList" style="max-height:420px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:6px"></div>
        </div>
      </div>
    </div>
    <div class="section">
      <div class="section-title" data-i18n="channelsUnmapped">未识别频道</div>
      <div id="unmappedList" style="font-size:0.8rem;max-height:220px;overflow:auto"></div>
    </div>
  </div>

  <!-- Health Tab -->
  <div class="tab-panel" id="panelHealth">
    <div class="section">
      <div class="section-title" data-i18n="healthTitle">源健康概览</div>
      <div id="healthSummary" style="display:flex;gap:18px;flex-wrap:wrap;font-size:0.82rem"></div>
    </div>
    <div class="section">
      <div class="section-title" data-i18n="healthDomains">按域名（谁在拖后腿）</div>
      <div id="healthDomains" style="max-height:420px;overflow:auto"></div>
    </div>
    <div class="section">
      <div class="section-title" data-i18n="healthReasons">失败原因分布</div>
      <div id="healthReasons" style="font-size:0.8rem"></div>
    </div>
    <div class="section">
      <div class="section-title" data-i18n="hostLedgerTitle">域名台账（死源按域名收敛）</div>
      <div id="hostStats" style="display:flex;gap:18px;flex-wrap:wrap;font-size:0.82rem;margin-bottom:8px"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <button class="btn btn-sm" onclick="reseedHosts()" data-i18n="hostLedgerReseed">按当前树重建</button>
        <span class="status-text" id="hostStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div id="hostTable" style="max-height:360px;overflow:auto"></div>
    </div>
    <div class="section">
      <div class="section-title" data-i18n="headVerifyTitle">输出前复核首位源</div>
      <label style="display:flex;align-items:center;gap:8px;font-size:0.82rem">
        <input type="checkbox" id="headVerifyCheck" onchange="saveHeadVerify()">
        <span data-i18n="headVerifyDesc">每台前 3 条先探一次，第一位不通就换下一条（会多花约 1 分钟）</span>
      </label>
      <span class="status-text" id="headVerifyStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
    </div>
  </div>

  <!-- Search Quota Tab -->
  <div class="tab-panel" id="panelSearchQuota">
    <div class="section">
      <div class="section-title" data-i18n="sqSelected">Active Search Sources</div>
      <div id="sqSelectedInfo" style="margin-bottom:8px;font-size:0.8rem;color:var(--text-secondary)"></div>
      <div id="sqSelectedTable" style="max-height:500px;overflow:auto">
        <div style="color:var(--text-secondary);font-size:0.85rem" data-i18n="sqNoData">Run aggregation to see results</div>
      </div>
    </div>
  </div>

  <!-- Cloud Tab -->
  <div class="tab-panel" id="panelCloud">
    <!-- 网盘登录 -->
    <div class="section">
      <div class="section-title" data-i18n="cloudLogin">Cloud Login</div>
      <div id="cloudLoginGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px">
      </div>
    </div>
    <!-- 手动粘贴凭证 -->
    <div class="section">
      <div class="section-title" data-i18n="cloudManualPaste">Manual Credential Paste</div>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
        <div style="flex:0 0 140px">
          <label class="form-label" data-i18n="cloudPlatform">Platform</label>
          <select id="manualPlatform" class="nt-input" style="width:100%"></select>
        </div>
        <div style="flex:1;min-width:200px">
          <label class="form-label" data-i18n="cloudCredentialValue">Credential (cookie / token / JSON)</label>
          <input id="manualCredValue" class="nt-input" style="width:100%" placeholder="cookie=xxx; token=yyy">
        </div>
        <button class="btn btn-sm" onclick="manualPasteCredential()" data-i18n="save">Save</button>
      </div>
      <div id="manualPasteStatus" class="status-text" style="margin-top:6px"></div>
    </div>
    <!-- 风险管理 -->
    <div class="section">
      <div class="section-title" data-i18n="cloudRiskManagement">Risk Management</div>
      <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-sm" onclick="loadRiskReport()" data-i18n="cloudLoadReport">Load Risk Report</button>
        <span id="riskSummary" style="font-family:var(--mono);font-size:0.75rem;color:var(--text-dim)"></span>
      </div>
      <div id="riskReportContainer" style="display:none">
        <div style="overflow-x:auto">
          <table class="list-table" style="width:100%;font-size:0.8rem">
            <thead>
              <tr>
                <th data-i18n="cloudRiskName">Name</th>
                <th>Spider</th>
                <th data-i18n="cloudRiskLevel">Risk</th>
                <th data-i18n="cloudRiskPlatforms">Platforms</th>
                <th data-i18n="cloudRiskDomains">3rd Party</th>
                <th data-i18n="cloudRiskAction">Action</th>
              </tr>
            </thead>
            <tbody id="riskReportBody"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <!-- Settings Tab -->
  <div class="tab-panel" id="panelSettings">
    <!-- Cron Interval -->
    <div class="section">
      <div class="section-title" data-i18n="cronInterval">Aggregation Schedule</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <select id="cronSelect" class="nt-input" style="width:auto;min-width:160px">
          <option value="60" data-i18n-text="cronEvery1h">Every 1 hour</option>
          <option value="180" data-i18n-text="cronEvery3h">Every 3 hours</option>
          <option value="360" data-i18n-text="cronEvery6h">Every 6 hours</option>
          <option value="720" data-i18n-text="cronEvery12h">Every 12 hours</option>
          <option value="1440" data-i18n-text="cronEveryDay">Once a day</option>
        </select>
        <button class="btn btn-sm" id="cronSaveBtn" onclick="saveCronInterval()" data-i18n="save">Save</button>
        <span class="status-text" id="cronStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
    </div>

    <div class="section" id="ftpSyncSection">
      <div class="section-title" data-i18n="ftpTitle">对外发布（FTP 同步）</div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="ftpEnabled" onchange="saveFtpSync()">
          <span data-i18n="ftpEnable">每次聚合完成后，把 live.txt 覆盖上传到 FTP</span>
        </label>
        <span class="status-text" id="ftpStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px">
        <div><label class="form-label" data-i18n="ftpHost">FTP 主机</label>
          <input id="ftpHost" class="nt-input" placeholder="ftp.example.com"></div>
        <div><label class="form-label" data-i18n="ftpPort">端口</label>
          <input id="ftpPort" class="nt-input" placeholder="21" value="21"></div>
        <div><label class="form-label" data-i18n="ftpUser">用户名</label>
          <input id="ftpUser" class="nt-input" autocomplete="off"></div>
        <div><label class="form-label" data-i18n="ftpPass">密码</label>
          <input id="ftpPass" class="nt-input" type="password" autocomplete="new-password" placeholder="留空则不修改"></div>
        <div><label class="form-label" data-i18n="ftpPath">远端路径</label>
          <input id="ftpPath" class="nt-input" placeholder="/wwwroot/live.txt" value="/live.txt"></div>
        <div><label class="form-label" data-i18n="ftpPublic">对外访问地址</label>
          <input id="ftpPublic" class="nt-input" placeholder="https://xx.com/live.txt"></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:0.8rem">
          <input type="checkbox" id="ftpSecure"> <span data-i18n="ftpSecure">使用 FTPS（显式 TLS）</span>
        </label>
        <button class="btn btn-sm" onclick="saveFtpSync()" data-i18n="save">保存</button>
        <button class="btn btn-sm" onclick="testFtpSync()" data-i18n="ftpTest">测试连接</button>
        <button class="btn btn-sm" onclick="runFtpSync()" data-i18n="ftpRunNow">立即上传</button>
      </div>
      <div style="font-size:0.75rem;color:var(--text-secondary);margin-top:6px" data-i18n="ftpHint">
        上传的是与 /live.txt 完全相同的内容（测速排序后的 DIYP 格式）。密码以明文存在本地数据库，建议单独建一个只对目标目录有写权限的 FTP 账号。
      </div>
    </div>

    <div class="section">
      <div class="section-title" data-i18n="edgeProxies">Edge Function Proxies</div>
      <div style="margin-bottom:6px;font-size:0.8rem;color:var(--text-secondary)" data-i18n="edgeProxiesDesc">Configure edge function URLs for proxy fallback (fetch retry + image CDN). Local Docker mode only.</div>
      <div class="nt-grid">
        <div>
          <label class="form-label">Cloudflare Worker URL</label>
          <input type="text" id="edgeCfUrl" class="nt-input" placeholder="https://tvbox.example.com">
        </div>
        <div>
          <label class="form-label">Vercel Proxy URL</label>
          <input type="text" id="edgeVercelUrl" class="nt-input" placeholder="https://fetch.example.com">
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <button class="btn btn-sm" onclick="saveEdgeProxies()" data-i18n="save">Save</button>
        <span class="status-text" id="edgeProxiesStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
    </div>

    <div class="section">
      <div class="section-title" data-i18n="searchQuota">Search Quota</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label class="form-label" style="margin:0" data-i18n="maxSearchable">Max searchable</label>
        <input type="number" id="maxSearchableInput" class="nt-input" style="width:80px" min="0" max="1000" value="0">
        <button class="btn btn-sm" id="searchQuotaSaveBtn" onclick="saveSearchQuota()" data-i18n="save">Save</button>
        <span class="status-text" id="searchQuotaStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div style="margin-top:6px;font-size:0.8rem;color:var(--text-secondary)" data-i18n="searchQuotaDesc">Limit searchable sources to reduce TVBox crashes. 0 = unlimited. JS sources are always excluded. Manage pinned sources in the Search tab.</div>
    </div>

    <div class="section">
      <div class="section-title" data-i18n="nameTransform">Name Transform</div>
      <div class="nt-grid">
        <div>
          <label class="form-label" data-i18n="ntPrefix">Prefix</label>
          <input type="text" id="ntPrefix" class="nt-input" placeholder="e.g. 【RioTV】" data-i18n-placeholder="ntPrefixPh">
        </div>
        <div>
          <label class="form-label" data-i18n="ntSuffix">Suffix</label>
          <input type="text" id="ntSuffix" class="nt-input" placeholder="e.g.  · Curated" data-i18n-placeholder="ntSuffixPh">
        </div>
      </div>
      <div style="margin-bottom:10px">
        <label class="form-label" data-i18n="ntPromoReplace">Promo Replacement (empty = delete)</label>
        <input type="text" id="ntPromoReplace" class="nt-input" placeholder="e.g. Premium" data-i18n-placeholder="ntPromoReplacePh">
      </div>
      <div style="margin-bottom:10px">
        <label class="form-label" data-i18n="ntExtraPatterns">Extra Clean Patterns (one regex per line)</label>
        <textarea id="ntExtraPatterns" class="nt-textarea" placeholder="e.g. sponsor[：:]\\S+" data-i18n-placeholder="ntExtraPatternsPh"></textarea>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn" id="ntSaveBtn" onclick="saveNameTransform()" data-i18n="save">Save</button>
        <span class="status-text" id="ntStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
    </div>

    <!-- 相似去重配置 -->
    <div class="section">
      <div class="section-title" data-i18n="dedupConfigTitle">Similar Name Dedup</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="similarDedupCheck" onchange="saveDedupConfig()" checked>
          <span data-i18n="similarDedupLabel">Enable similar-name dedup (keep fastest)</span>
        </label>
      </div>
      <div style="margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label class="form-label" style="margin:0" data-i18n="dedupThreshold">Threshold</label>
        <input type="range" id="dedupThreshold" min="50" max="100" value="85" style="width:120px" oninput="$('dedupThresholdVal').textContent=this.value+'%'">
        <span id="dedupThresholdVal" style="font-family:var(--mono);font-size:0.8rem">85%</span>
        <button class="btn btn-sm" onclick="saveDedupConfig()" data-i18n="save">Save</button>
        <span class="status-text" id="dedupStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
    </div>

    <!-- 分组排序 -->
    <div class="section">
      <div class="section-title" data-i18n="groupOrderTitle">Site Group Order</div>
      <div style="margin-bottom:10px;display:flex;gap:10px;align-items:center">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="groupOrderEnabled" onchange="saveGroupOrder()">
          <span data-i18n="groupOrderEnabled">Enable group ordering</span>
        </label>
        <select id="groupOrderUnmatched" class="nt-input" style="width:auto;min-width:120px" onchange="saveGroupOrder()">
          <option value="after">Unmatched → after</option>
          <option value="before">Unmatched → before</option>
        </select>
        <span class="status-text" id="groupOrderStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div id="groupOrderRules"></div>
      <button class="btn btn-sm" onclick="addGroupRule()" style="margin-top:8px" data-i18n="groupOrderAdd">+ Add Rule</button>
    </div>

    <!-- 背景设置 -->
    <div class="section">
      <div class="section-title" data-i18n="bgSettingsTitle">Background Settings</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <select id="bgType" class="nt-input" style="width:auto;min-width:120px" onchange="onBgTypeChange()">
          <option value="default">Default</option>
          <option value="image">Image URL</option>
          <option value="solid">Solid Color</option>
          <option value="gradient">Gradient</option>
        </select>
      </div>
      <div id="bgImageGroup" style="display:none;margin-bottom:10px">
        <input type="text" id="bgImageUrl" class="nt-input" placeholder="https://example.com/bg.jpg">
      </div>
      <div id="bgSolidGroup" style="display:none;margin-bottom:10px">
        <input type="color" id="bgSolidColor" value="#0a0e14" style="width:50px;height:30px;border:none;cursor:pointer">
      </div>
      <div id="bgGradientGroup" style="display:none;margin-bottom:10px">
        <input type="text" id="bgGradient" class="nt-input" placeholder="linear-gradient(180deg, #0a0e14, #1a2030)">
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-sm" onclick="saveBgSettings()" data-i18n="save">Save</button>
        <span class="status-text" id="bgStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
    </div>

    <!-- 智能 Base URL -->
    <div class="section">
      <div class="section-title" data-i18n="smartBaseUrlTitle">Smart Base URL</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="smartBaseUrlCheck" onchange="saveSmartBaseUrl()">
          <span data-i18n="smartBaseUrlLabel">Auto-detect client host for JAR/image URLs (LAN only, set DMZ=0 to allow public)</span>
        </label>
        <span class="status-text" id="smartBaseUrlStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
    </div>

    <!-- 站点测速与验活（一个功能，三个层级：总开关 → 验活深度 → 清理策略） -->
    <div class="section">
      <div class="section-title" data-i18n="siteProbeTitle">Site Speed Test &amp; Auto Clean</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="speedTestCheck" onchange="saveSpeedTest()" checked>
          <span data-i18n="speedTestLabel">启用站点测速与不可达剔除</span>
        </label>
        <span class="status-text" id="speedTestStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:8px" data-i18n="speedTestDesc">关闭后保留所有站点，不进行可达性检测，下面的验活与清理策略同时失效。</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <label class="form-label" style="margin:0" data-i18n="probeDepthLabel">Probe depth:</label>
        <select id="probeDepthSelect" class="nt-input" style="width:auto;min-width:140px" onchange="saveProbeDepth()">
          <option value="deep" data-i18n-text="probeDeep">Deep (validate content)</option>
          <option value="shallow" data-i18n-text="probeShallow">Shallow (HTTP only)</option>
        </select>
        <span class="status-text" id="probeDepthStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="autoCleanCheck" onchange="saveAutoClean()">
          <span data-i18n="autoCleanLabel">Auto-blacklist after 5 consecutive failures (max 5/run)</span>
        </label>
        <span class="status-text" id="autoCleanStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:6px">
        <span style="font-size:0.82rem;color:var(--text-secondary)" data-i18n="autoCleanModeLabel">处理方式：</span>
        <select id="autoCleanMode" class="nt-input" style="width:auto;min-width:220px" onchange="saveKeepLink()">
          <option value="delete" data-i18n="autoCleanModeDelete">删除站点（从输出中移除）</option>
          <option value="keep" data-i18n="autoCleanModeKeep">保留链接（仅跳过后续探测）</option>
        </select>
        <button class="btn btn-sm" onclick="clearSkipList()" data-i18n="clearSkipBtn">清空跳过名单</button>
        <span class="status-text" id="keepLinkStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div style="margin-top:6px;font-size:0.8rem;color:var(--text-dim)" data-i18n="siteProbeDesc">Deep mode checks type0/type1 content validity. Failed sites get [⚠] marker after 3 failures.</div>
    </div>
  </div>

  <!-- Agg Logs Tab -->
  <div class="tab-panel" id="panelAggLogs">
    <div class="section">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div class="section-title" style="margin:0">调度执行历史（最近 7 天）</div>
        <button class="btn btn-sm" onclick="loadRunHistory()">刷新</button>
      </div>
      <div id="runSummary" style="display:flex;gap:18px;flex-wrap:wrap;font-size:0.82rem;margin-bottom:10px"></div>
      <div id="runDaily" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;font-size:0.7rem"></div>
      <div id="runTable" style="max-height:320px;overflow:auto"></div>
      <div style="margin-top:6px;font-size:0.72rem;color:var(--text-dim)">
        进程被杀/断电导致的悬空执行，会在下次启动后自动收尾为「进程中断」。
      </div>
    </div>

    <div class="section">
      <div class="section-title">失败告警</div>
      <label style="display:flex;align-items:center;gap:8px;font-size:0.82rem;margin-bottom:10px">
        <input type="checkbox" id="alertEnabled">
        <span>启用告警（聚合失败 / 超时 / 超过 26 小时没成功时主动推送）</span>
      </label>
      <div class="add-form">
        <input type="url" id="alertWebhook" placeholder="Webhook URL（POST JSON，可接企业微信/飞书机器人）">
        <input class="name-input" type="text" id="alertTgToken" placeholder="Telegram Bot Token（可选）">
        <input class="name-input" type="text" id="alertTgChat" placeholder="Telegram Chat ID（可选）">
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:0.82rem;margin-top:8px">
        <input type="checkbox" id="alertOnSuccess">
        <span>成功也通知（默认只在异常时提醒）</span>
      </label>
      <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
        <button class="btn btn-sm btn-primary" onclick="saveAlertConfig()">保存</button>
        <button class="btn btn-sm" onclick="testAlert()">发送测试</button>
        <span class="status-text" id="alertStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div style="margin-top:6px;font-size:0.72rem;color:var(--text-dim)">
        同一类告警 6 小时内只发一次；未配置通道时只在后台标红，不会静默。
      </div>
    </div>

    <div class="section">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div class="section-title" style="margin:0" data-i18n="aggLogsTitle">Aggregation Logs</div>
        <button class="btn btn-sm" onclick="clearAggLogs()" data-i18n="clearLogs">Clear All</button>
      </div>
      <div id="aggLogsList" style="font-size:0.85rem"></div>
    </div>
  </div>

  <div class="footer">
    <span data-i18n="footer">TVBox Source Aggregator &middot; Admin Console</span>
  </div>
</div>

<script>
${sharedUi}

// --- i18n ---
const translations = {
  en: {
    loginTitle:'Admin Access', loginSubtitle:'TVBox Aggregator Management',
    invalidToken:'Invalid token', enterToken:'Enter admin token', login:'Login',
    connectionFailed:'Connection failed',
    headerLabel:'Admin Console', navConfigEditor:'Config Editor', navDashboard:'Dashboard',
    tabSources:'Sources', tabMacCMS:'MacCMS', tabLive:'Live', tabSettings:'Settings', tabAggLogs:'Logs',
    aggLogsTitle:'Aggregation Logs', clearLogs:'Clear All',
    dedupConfigTitle:'Similar Name Dedup', similarDedupLabel:'Enable similar-name dedup (keep fastest)', dedupThreshold:'Threshold',
    groupOrderTitle:'Site Group Order', groupOrderEnabled:'Enable group ordering', groupOrderAdd:'+ Add Rule',
    bgSettingsTitle:'Background Settings',
    addSource:'Add Source', aggregation:'Aggregation', sourcesList:'Sources',
    addMacCMS:'Add MacCMS Source', macCMSSources:'MacCMS Sources',
    addLiveSource:'Add Live Source', liveSources:'Live Sources',
    nameOptional:'Name (optional)', configJsonUrl:'TVBox config JSON URL',
    mcKeyPh:'Key (e.g. hongniuzy)', mcNamePh:'Name', mcApiPh:'MacCMS API URL',
    liveNamePh:'Name (e.g. iptv365)', liveUrlPh:'m3u/txt URL',
    add:'Add', adding:'Adding...', batchImport:'Batch Import',
    submitBatch:'Submit Batch',
    refresh:'Refresh', running:'Running...', remove:'Remove', test:'Test',
    loadingStatus:'Loading...',
    lastUpdate:'Last update: ', neverUpdated:'Never updated — click Refresh',
    failedLoadStatus:'Failed to load status',
    noSources:'No sources configured. Add one above.',
    noMacCMS:'No MacCMS sources. Add one above.',
    noLives:'No live sources. Add one above.',
    failedLoad:'Failed to load sources',
    failedLoadMacCMS:'Failed to load MacCMS sources',
    failedLoadLives:'Failed to load live sources',
    sourceAdded:'Source added', sourceRemoved:'Source removed',
    networkError:'Network error', testing:'Testing...',
    valid:'Valid', invalidUnreachable:'Invalid / Unreachable',
    liveSourceAdded:'Live source added', removed:'Removed',
    invalidJson:'Invalid JSON', mustBeArray:'Must be a JSON array',
    allFieldsRequired:'All fields required', importFailed:'Import failed',
    aggregationStarted:'Aggregation started', refreshFailed:'Refresh failed',
    importConfig:'Import Config', import:'Import', importing:'Importing...',
    importPlaceholder:'Paste TVBox JSON or URL here...',
    importMulti:'Multi-repo detected', importSingle:'Single config detected',
    importAdded:'added', importDuplicates:'duplicates', importParseFailed:'Failed to parse',
    nameTransform:'Name Transform', ntPrefix:'Prefix', ntSuffix:'Suffix',
    ntPromoReplace:'Promo Replacement (empty = delete)', ntExtraPatterns:'Extra Clean Patterns (one regex per line)',
    ntPrefixPh:'e.g. 【RioTV】', ntSuffixPh:'e.g.  · Curated',
    ntPromoReplacePh:'e.g. Premium', ntExtraPatternsPh:'e.g. sponsor[：:]\\\\S+',
    cronInterval:'Aggregation Schedule',
    speedTestToggle:'Site Speed Test', speedTestLabel:'Enable site speed test and unreachable filtering', speedTestDesc:'When disabled, all sites are kept without testing reachability',
    edgeProxies:'Edge Function Proxies', edgeProxiesDesc:'Configure edge function URLs for proxy fallback (fetch retry + image CDN). Local Docker mode only.',
    refreshing:'Refreshing...', loading:'Loading...',
    cronEvery1h:'Every 1 hour', cronEvery3h:'Every 3 hours', cronEvery6h:'Every 6 hours',
    cronEvery12h:'Every 12 hours', cronEveryDay:'Once a day',
    save:'Save', saving:'Saving...', saved:'Saved', saveFailed:'Save failed',
    noHealthData:'No data yet', healthFails:'Fails',
    healthLastOk:'Last OK',
    searchQuota:'Search Quota',
    maxSearchable:'Max searchable', searchQuotaDesc:'Limit searchable sources to reduce TVBox crashes. 0 = unlimited. Manage pinned sources in the Search tab.',
    tabSearchQuota:'Search',
    sqSelected:'Active Search Sources', sqNoData:'Run aggregation to see results',
    sqKey:'Key', sqName:'Name', sqSource:'Source', sqReason:'Reason', sqAction:'Action',
    sqPin:'Pin', sqUnpin:'Unpin',
    sqPinned:'Pinned', sqPinnedDesc:'Drag to reorder. Top sources are searched first in TVBox.', sqOtherSources:'Other Sources',
    sqHttp:'http', sqMainJar:'main jar', sqIndepJar:'indep jar',
    channelProbeTitle:'Channel Speed Probe (Node/Docker)',
    channelProbeEnable:'Enable scheduled channel speed test (every 2h)',
    liveFilterTitle:'Channel Filter',
    useConfigLivesLabel:'Use live sources bundled in config files (off by default; brings in lots of non-TV entries)',
    shoppingFilterLabel:'Remove shopping / promo channels automatically',
    shoppingFilterHint:'Channels matching any keyword are dropped before merging and speed testing. Comma separated; avoid vague words like 精选.',
    probeInlineLabel:'Run speed test inside aggregation (no separate schedule)',
    probeSegmentLabel:'Verify a real segment (recommended)',
    probeClearCache:'Clear probe cache',
    probeClearCacheConfirm:'Clear all speed results? The next run will re-probe every URL (slower, but needed after changing the rules).',
    probeClearCacheDone:'Cleared {n} entries',
    groupMergeTitle:'Group Merge',
    groupMergeEnable:'Merge messy groups into standard ones',
    groupMergeReset:'Reset rules',
    groupMergeHint:'One "keyword=target" per line, first match wins; unmatched go to 其他. Only affects grouping, not channel merging or speed sorting.',
    groupMergeSaved:'Saved',
    groupMergeResetConfirm:'Reset group merge rules to defaults?',
    groupMergeResetDone:'Defaults restored',
    tabChannels:'Channels',
    tabHealth:'Source Health',
    channelsTitle:'Channels & Sources',
    channelsCurationHint:'CCTV / Satellite / Nanjing locals are auto-ordered. "Pin" moves a channel to the top of its group; "Disable" removes it from the output (reversible).',
    channelsTopN:'keep', channelsTopNUnit:'sources per channel',
    channelsOptimize:'Optimize',
    channelsOptimizeConfirm:'Keep only the top {n} sources per channel?',
    channelsOptimizeDone:'Applied: top {n}',
    channelsDeleteConfirm:'Remove this source? It goes to the dead-source blacklist (reversible).',
    channelsDeleted:'Removed',
    channelsUnmapped:'Unmapped channels',
    healthTitle:'Source health',
    healthDomains:'By domain',
    healthReasons:'Failure reasons',
    hostLedgerTitle:'Host ledger (dead sources grouped by domain)',
    hostLedgerReseed:'Rebuild from current tree',
    hostLedgerReseedConfirm:'Rebuild the host ledger from the current channel tree?',
    headVerifyTitle:'Verify first source before output',
    headVerifyDesc:'Probe up to 3 sources per channel and promote a working one to the top (adds ~1 minute).',
    channelOrderTitle:'Channel Order',
    channelOrderSmart:'Smart sort (CCTV)',
    channelOrderSave:'Save order',
    channelOrderReset:'Reset',
    channelOrderHint:'CCTV / Satellite / Local are auto-ordered by channel curation (Nanjing locals pinned to the top). Dragging here only affects other groups.',
    channelOrderEmpty:'No channels. Run aggregation first.',
    channelOrderNeedRefresh:'Run aggregation first',
    channelOrderDirty:'Unsaved changes',
    channelOrderSaved:'Order saved',
    channelOrderSorting:'Sorting...',
    channelOrderSmartDone:'Sorted {kept} channels, moved out {moved}',
    channelOrderMoved:'Moved to 其他: {list}',
    channelOrderResetConfirm:'Clear custom channel order and moves?',
    channelOrderResetDone:'Reset done',
    channelProbeTrigger:'Run Now',
    channelProbeDropDead:'Clean Dead Sources',
    channelProbeRestoreDead:'Restore',
    channelProbeRestoreConfirm:'Clear the dead-source blacklist and re-aggregate?',
    channelProbeRestored:'Restored {n} sources',
    channelProbePartial:'Partial (budget reached, continues next round)',
    channelProbePending:'Left for next round',
    channelProbeDeadListed:'Dead source blacklist',
    channelProbeDropConfirm:'Delete all sources that failed the speed test from the output? They are added to a dead-source blacklist and auto-restored if they come back.',
    channelProbeDropped:'Removed {n} dead sources',
    channelProbeIdle:'Idle', channelProbeRunning:'Running', channelProbeDone:'Completed', channelProbeError:'Error',
    channelProbeState:'State', channelProbeProgress:'Progress', channelProbeCoverage:'Coverage',
    channelProbeChannels:'Channels', channelProbeDuration:'Duration', channelProbeFinished:'Finished at',
    channelProbeStarted:'Probe started', channelProbeDisabledFirst:'Enable probe first', channelProbeAlreadyRunning:'Already running',
    channelProbeCfOnly:'Only Node/Docker supports channel probing',
    liveToggleTitle:'Live Feature Toggle', liveToggleLabel:'Disable live aggregation (skip live merge, output empty lives)',
    smartBaseUrlTitle:'Smart Base URL', smartBaseUrlLabel:'Auto-detect client host for JAR/image URLs (LAN only, set DMZ=0 to allow public)',
    autoCleanModeLabel:'Action:',
    autoCleanModeDelete:'Delete site (remove from output)',
    autoCleanModeKeep:'Keep link (skip probing only)',
    clearSkipBtn:'Clear skip list',
    skipCount:'Skipping {n} sites',
    clearSkipConfirm:'Clear the skip list? Skipped sites will be probed again.',
    clearSkipDone:'Skip list cleared',
    ftpTitle:'Publish (FTP sync)',
    ftpEnable:'Upload live.txt to FTP after each aggregation',
    ftpHost:'FTP host', ftpPort:'Port', ftpUser:'Username', ftpPass:'Password',
    ftpPath:'Remote path', ftpPublic:'Public URL', ftpSecure:'Use FTPS (explicit TLS)',
    ftpTest:'Test connection', ftpRunNow:'Upload now',
    ftpHint:'Uploads exactly what /live.txt returns (speed-sorted DIYP format). Password is stored in plain text; use a dedicated write-only FTP account.',
    ftpWritable:'writable', ftpNotWritable:'NOT writable',
    ftpPassKeep:'leave blank to keep', ftpTesting:'Testing...', ftpTestOk:'Connection OK',
    ftpTestFail:'Connection failed', ftpUploading:'Uploading...',
    ftpUploadOk:'Uploaded {n} bytes', ftpUploadFail:'Upload failed',
    siteProbeTitle:'Site Speed Test & Auto Clean', probeDepthLabel:'Probe depth:',
    probeDeep:'Deep (validate content)', probeShallow:'Shallow (HTTP only)',
    autoCleanLabel:'Auto-blacklist after 5 consecutive failures (max 5/run)',
    siteProbeDesc:'Deep mode checks type0/type1 content validity. Failed sites get [⚠] marker after 3 failures.',
    footer:'TVBox Source Aggregator &middot; Admin Console',
  },
  zh: {
    loginTitle:'管理登录', loginSubtitle:'TVBox 聚合器管理',
    invalidToken:'无效的令牌', enterToken:'请输入管理令牌', login:'登录',
    connectionFailed:'连接失败',
    headerLabel:'管理控制台', navConfigEditor:'配置编辑', navDashboard:'仪表盘',
    tabSources:'源', tabMacCMS:'MacCMS', tabLive:'直播', tabSettings:'设置', tabAggLogs:'日志',
    aggLogsTitle:'聚合日志', clearLogs:'清空',
    dedupConfigTitle:'相似名称去重', similarDedupLabel:'启用相似名称去重（保留最快）', dedupThreshold:'阈值',
    groupOrderTitle:'站点分组排序', groupOrderEnabled:'启用分组排序', groupOrderAdd:'+ 添加规则',
    bgSettingsTitle:'背景设置',
    addSource:'添加源', aggregation:'聚合', sourcesList:'源列表',
    addMacCMS:'添加 MacCMS 源', macCMSSources:'MacCMS 源列表',
    addLiveSource:'添加直播源', liveSources:'直播源列表',
    nameOptional:'名称（可选）', configJsonUrl:'TVBox 配置 JSON 地址',
    mcKeyPh:'Key（如 hongniuzy）', mcNamePh:'名称', mcApiPh:'MacCMS API 地址',
    liveNamePh:'名称（如 iptv365）', liveUrlPh:'m3u/txt 地址',
    add:'添加', adding:'添加中...', batchImport:'批量导入',
    submitBatch:'提交批量',
    refresh:'刷新', running:'运行中...', remove:'删除', test:'测试',
    loadingStatus:'加载中...',
    lastUpdate:'上次更新: ', neverUpdated:'从未更新 — 点击刷新',
    failedLoadStatus:'获取状态失败',
    noSources:'暂无源。请在上方添加。',
    noMacCMS:'暂无 MacCMS 源。请在上方添加。',
    noLives:'暂无直播源。请在上方添加。',
    failedLoad:'加载源失败',
    failedLoadMacCMS:'加载 MacCMS 源失败',
    failedLoadLives:'加载直播源失败',
    sourceAdded:'源已添加', sourceRemoved:'源已删除',
    networkError:'网络错误', testing:'测试中...',
    valid:'有效', invalidUnreachable:'无效/不可达',
    liveSourceAdded:'直播源已添加', removed:'已删除',
    invalidJson:'无效的 JSON', mustBeArray:'必须是 JSON 数组',
    allFieldsRequired:'所有字段必填', importFailed:'导入失败',
    aggregationStarted:'聚合已开始', refreshFailed:'刷新失败',
    importConfig:'导入配置', import:'导入', importing:'导入中...',
    importPlaceholder:'粘贴 TVBox JSON 内容或 URL...',
    importMulti:'检测到多仓', importSingle:'检测到单仓',
    importAdded:'已添加', importDuplicates:'重复跳过', importParseFailed:'解析失败',
    nameTransform:'名称定制', ntPrefix:'前缀', ntSuffix:'后缀',
    ntPromoReplace:'推广替换文字（留空则删除）', ntExtraPatterns:'额外清洗正则（每行一条）',
    ntPrefixPh:'如 【RioTV】', ntSuffixPh:'如  · 精选',
    ntPromoReplacePh:'如 精选推荐', ntExtraPatternsPh:'如 sponsor[：:]\\\\S+',
    cronInterval:'聚合频率',
    speedTestToggle:'站点测速', speedTestLabel:'启用站点测速与不可达剔除', speedTestDesc:'关闭后保留所有站点，不进行可达性检测',
    edgeProxies:'边缘函数代理', edgeProxiesDesc:'配置边缘函数 URL，用于本地 Docker 模式的请求代理回退和图片 CDN 加速',
    refreshing:'刷新中...', loading:'加载中...',
    cronEvery1h:'每 1 小时', cronEvery3h:'每 3 小时', cronEvery6h:'每 6 小时',
    cronEvery12h:'每 12 小时', cronEveryDay:'每天一次',
    save:'保存', saving:'保存中...', saved:'已保存', saveFailed:'保存失败',
    noHealthData:'暂无数据', healthFails:'失败',
    healthLastOk:'最后成功',
    searchQuota:'搜索配额',
    maxSearchable:'可搜索源上限', searchQuotaDesc:'限制可搜索源数量，减少 TVBox 搜索崩溃。0 = 不限制。置顶源在搜索页签管理。',
    tabSearchQuota:'搜索',
    sqSelected:'活跃搜索源', sqNoData:'执行聚合后查看结果',
    sqKey:'Key', sqName:'名称', sqSource:'来源', sqReason:'原因', sqAction:'操作',
    sqPin:'置顶', sqUnpin:'取消置顶',
    sqPinned:'置顶源', sqPinnedDesc:'上下移动排序，排在前面的源在 TVBox 搜索时优先执行', sqOtherSources:'其他源',
    sqHttp:'HTTP', sqMainJar:'主 JAR', sqIndepJar:'独立 JAR',
    channelProbeTitle:'频道级测速（仅 Node/Docker）',
    channelProbeEnable:'启用定时频道测速（每 2 小时）',
    liveFilterTitle:'频道过滤',
    useConfigLivesLabel:'采用配置源自带的直播源（默认关闭，开了会掺入大量非电视条目）',
    shoppingFilterLabel:'自动删除购物/推广频道',
    shoppingFilterHint:'命中任一关键词的频道会被直接剔除（不参与合并与测速）。逗号分隔；注意别用「精选」这类会误伤音乐合辑的词。',
    probeInlineLabel:'测速并入聚合流程（不再单独定时跑）',
    probeSegmentLabel:'分片复验（拉一小段视频确认真能播）',
    probeClearCache:'清空测速缓存',
    probeClearCacheConfirm:'清空全部测速结果？下一轮会重新探测所有 URL（更慢，但改了判定规则后必须这么做）',
    probeClearCacheDone:'已清空 {n} 条',
    groupMergeTitle:'分组归并',
    groupMergeEnable:'启用分组归并（把各源的杂组收进标准分组）',
    groupMergeReset:'恢复默认规则',
    groupMergeHint:'每行一条「关键词=目标分组」，按顺序匹配，认不出的归入「其他」。只影响分组归属，不影响频道合并与测速排序。',
    groupMergeSaved:'已保存',
    groupMergeResetConfirm:'恢复默认的分组归并规则？',
    groupMergeResetDone:'已恢复默认',
    tabChannels:'频道',
    tabHealth:'源健康',
    channelsTitle:'频道与源',
    channelsCurationHint:'央视 / 卫视 / 南京地方台已按编排自动排序；「置顶」把频道提到组首，「禁用」从输出里移除（可撤销）。',
    channelsTopN:'每台保留', channelsTopNUnit:'条源',
    channelsOptimize:'一键选优',
    channelsOptimizeConfirm:'每台只保留前 {n} 条源？',
    channelsOptimizeDone:'已应用：每台 {n} 条',
    channelsDeleteConfirm:'删除这条源？会进死源黑名单（可回滚）',
    channelsDeleted:'已删除',
    channelsUnmapped:'未识别频道',
    healthTitle:'源健康概览',
    healthDomains:'按域名（谁在拖后腿）',
    healthReasons:'失败原因分布',
    hostLedgerTitle:'域名台账（死源按域名收敛）',
    hostLedgerReseed:'按当前树重建',
    hostLedgerReseedConfirm:'按当前频道树重建域名台账？',
    headVerifyTitle:'输出前复核首位源',
    headVerifyDesc:'每台前 3 条先探一次，第一位不通就换下一条（会多花约 1 分钟）。',
    channelOrderTitle:'频道排序',
    channelOrderSmart:'一键智能排序（央视）',
    channelOrderSave:'保存排序',
    channelOrderReset:'恢复默认',
    channelOrderHint:'央视 / 卫视 / 境内地方 由「频道编排」自动排序（卫视居前、南京地方台置顶），这里拖动只对其余分组生效。',
    channelOrderEmpty:'暂无频道，请先执行一次聚合',
    channelOrderNeedRefresh:'请先执行一次聚合',
    channelOrderDirty:'有未保存的调整',
    channelOrderSaved:'排序已保存',
    channelOrderSorting:'排序中...',
    channelOrderSmartDone:'已排序 {kept} 个频道，移出 {moved} 个',
    channelOrderMoved:'已移到「其他」：{list}',
    channelOrderResetConfirm:'清空自定义排序与移出规则？',
    channelOrderResetDone:'已恢复默认',
    channelProbeTrigger:'立即执行',
    channelProbeDropDead:'清理死源',
    channelProbeRestoreDead:'恢复死源',
    channelProbeRestoreConfirm:'清空死源黑名单并重新聚合？',
    channelProbeRestored:'已恢复 {n} 个源',
    channelProbePartial:'部分完成（超出预算，下轮继续）',
    channelProbePending:'留给下轮',
    channelProbeDeadListed:'死源黑名单',
    channelProbeDropConfirm:'把测速失败的源从输出中删除？（会加入死源黑名单长期生效；源恢复可用后会自动放回来）',
    channelProbeDropped:'已清理 {n} 个死源',
    channelProbeIdle:'空闲', channelProbeRunning:'运行中', channelProbeDone:'已完成', channelProbeError:'失败',
    channelProbeState:'状态', channelProbeProgress:'进度', channelProbeCoverage:'覆盖率',
    channelProbeChannels:'频道数', channelProbeDuration:'耗时', channelProbeFinished:'完成时间',
    channelProbeStarted:'测速已启动', channelProbeDisabledFirst:'请先启用测速', channelProbeAlreadyRunning:'已在运行',
    channelProbeCfOnly:'仅 Node/Docker 支持频道级测速',
    liveToggleTitle:'直播功能', liveToggleLabel:'禁用直播聚合（跳过直播合并，输出空 lives）',
    smartBaseUrlTitle:'智能地址响应', smartBaseUrlLabel:'根据客户端访问地址自动生成资源链接（仅局域网，设置 DMZ=0 允许公网）',
    autoCleanModeLabel:'处理方式：',
    autoCleanModeDelete:'删除站点（从输出中移除）',
    autoCleanModeKeep:'保留链接（仅跳过后续探测）',
    clearSkipBtn:'清空跳过名单',
    skipCount:'正在跳过 {n} 个站点',
    clearSkipConfirm:'清空跳过名单？这些站点会重新参与探测',
    clearSkipDone:'跳过名单已清空',
    ftpTitle:'对外发布（FTP 同步）',
    ftpEnable:'每次聚合完成后，把 live.txt 覆盖上传到 FTP',
    ftpHost:'FTP 主机', ftpPort:'端口', ftpUser:'用户名', ftpPass:'密码',
    ftpPath:'远端路径', ftpPublic:'对外访问地址', ftpSecure:'使用 FTPS（显式 TLS）',
    ftpTest:'测试连接', ftpRunNow:'立即上传',
    ftpHint:'上传的是与 /live.txt 完全相同的内容（测速排序后的 DIYP 格式）。密码以明文存在本地数据库，建议单独建一个只对目标目录有写权限的 FTP 账号。',
    ftpWritable:'可写', ftpNotWritable:'不可写',
    ftpPassKeep:'留空则不修改', ftpTesting:'测试中...', ftpTestOk:'连接成功',
    ftpTestFail:'连接失败', ftpUploading:'上传中...',
    ftpUploadOk:'已上传 {n} 字节', ftpUploadFail:'上传失败',
    siteProbeTitle:'站点测速与验活', probeDepthLabel:'验活深度：',
    probeDeep:'深度（验证内容有效性）', probeShallow:'浅层（仅 HTTP 可达）',
    autoCleanLabel:'连续失败 5 次自动屏蔽（每次最多 5 个）',
    siteProbeDesc:'深度模式会检查 type0/type1 站点是否返回有效内容。连续失败 3 次的站点会被标记 [⚠]。',
    footer:'TVBox 源聚合器 &middot; 管理控制台',
  }
};

function t(key) { const l = getLang(); return translations[l]?.[key] || translations.en[key] || key; }

function doToggleLang() {
  const next = getLang() === 'zh' ? 'en' : 'zh';
  localStorage.setItem('lang', next);
  applyLang(translations, next);
  loadAll();
}

// --- Auth ---
const auth = initAuth('loginInput', 'loginError', 'loginOverlay', 'mainContent', '/admin/sources', loadAll);

// --- Tab switching ---
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => {
    const id = 'panel' + tab.charAt(0).toUpperCase() + tab.slice(1);
    p.classList.toggle('active', p.id === id);
  });
  // 排序面板数据依赖登录态，切到直播页时重新拉一次，避免登录前初始化时 401 后一直是空
  if (tab === 'live') loadChannelOrder();
  if (tab === 'channels') { loadChannelOrder(); loadChannels(); loadQuality(); loadCurationRules(); }
  if (tab === 'health') loadHealth();
  if (tab === 'aggLogs') { loadRunHistory(); loadAlertConfig(); }
}

// --- Source health ---
let healthMap = {};

async function loadSourceHealth() {
  try {
    const res = await fetch('/source-status');
    const records = await res.json();
    healthMap = {};
    records.forEach(r => { healthMap[r.url] = r; });
  } catch {
    healthMap = {};
  }
}

// --- Load data ---
async function loadAll() {
  await loadSourceHealth();
  loadSources();
  loadMacCMS();
  loadLives();
  loadStatus();
  loadNameTransform();
  loadCronInterval();
  loadSpeedTest();
  loadEdgeProxies();
  loadSearchQuota();
  loadCloudCredentials();
  loadChannelProbe();
  loadChannelOrder();
  loadDedupConfig();
  loadGroupOrder();
  loadBgSettings();
  loadAggLogs();
  loadRunHistory();
  loadAlertConfig();
  loadQuality();
  loadCurationRules();
}

async function loadStatus() {
  try {
    const res = await fetch('/status-data');
    const d = await res.json();
    if (d.lastUpdate && d.lastUpdate !== 'never') {
      const date = new Date(d.lastUpdate);
      const fmt = date.toLocaleString('zh-CN', {
        year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', second:'2-digit',
        hour12: false
      });
      $('aggStatus').textContent = t('lastUpdate') + fmt + ' | ' + d.sites + ' sites, ' + d.parses + ' parses, ' + d.lives + ' lives' + (d.liveSourceCount ? ', ' + d.liveSourceCount + ' live sources' : '');
      $('aggStatus').className = 'status-text';
    } else {
      $('aggStatus').textContent = t('neverUpdated');
      $('aggStatus').className = 'status-text error';
    }
  } catch {
    $('aggStatus').textContent = t('failedLoadStatus');
    $('aggStatus').className = 'status-text error';
  }
}

async function loadSources() {
  const list = $('sourceList');
  try {
    const res = await auth.authFetch('/admin/sources');
    const sources = await res.json();
    $('sourceCount').textContent = sources.length;
    $('badgeSources').textContent = sources.length;

    if (sources.length === 0) {
      list.innerHTML = '<div class="empty">' + t('noSources') + '</div>';
      return;
    }

    list.innerHTML = sources.map(s => {
      const h = healthMap[s.url];
      const level = !h ? 'unknown'
        : h.consecutiveFailures >= 5 ? 'error'
        : h.consecutiveFailures >= 3 ? 'warn' : 'ok';
      const tip = !h ? t('noHealthData')
        : h.latestStatus + ' | ' + t('healthFails') + ': ' + h.consecutiveFailures +
          (h.lastSuccessTime ? ' | ' + t('healthLastOk') + ': ' + new Date(h.lastSuccessTime).toLocaleString() : '');

      return \`<div class="source-item">
        <span class="source-health-dot \${level}" data-tooltip="\${esc(tip)}"></span>
        <div class="source-info">
          <div class="source-name">\${esc(s.name || 'Unnamed')}\${s.configKey ? ' 🔑' : ''}</div>
          <div class="source-url">\${esc(s.url)}</div>
        </div>
        <div class="source-actions">
          <button class="btn btn-sm btn-danger" onclick="removeSource('\${esc(s.url)}')">\${t('remove')}</button>
        </div>
      </div>\`;
    }).join('');
  } catch {
    list.innerHTML = '<div class="empty">' + t('failedLoad') + '</div>';
  }
}

// --- Add source ---
async function addSource() {
  const url = $('addUrl').value.trim();
  if (!url) { $('addUrl').focus(); return; }
  const name = $('addName').value.trim() || '';
  const configKey = $('addConfigKey').value.trim() || '';

  const btn = $('addBtn');
  btn.textContent = t('adding');
  btn.className = 'btn loading';

  try {
    const payload = { name, url };
    if (configKey) payload.configKey = configKey;
    const res = await auth.authFetch('/admin/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await res.json();
    if (res.ok) {
      toast(t('sourceAdded'));
      $('addUrl').value = '';
      $('addName').value = '';
      $('addConfigKey').value = '';
      loadSources();
    } else {
      toast(d.error || t('failedLoad'), 'error');
    }
  } catch {
    toast(t('networkError'), 'error');
  }

  btn.textContent = t('add');
  btn.className = 'btn';
}

// --- Remove source ---
async function removeSource(url) {
  try {
    const res = await auth.authFetch('/admin/sources', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (res.ok) {
      toast(t('sourceRemoved'));
      loadSources();
    } else {
      const d = await res.json();
      toast(d.error || t('remove'), 'error');
    }
  } catch {
    toast(t('networkError'), 'error');
  }
}

// --- MacCMS ---
async function loadMacCMS() {
  const list = $('mcList');
  try {
    const res = await auth.authFetch('/admin/maccms');
    const sources = await res.json();
    $('mcCount').textContent = sources.length;
    $('badgeMacCMS').textContent = sources.length;

    if (sources.length === 0) {
      list.innerHTML = '<div class="empty">' + t('noMacCMS') + '</div>';
      return;
    }

    list.innerHTML = sources.map(s => \`
      <div class="source-item">
        <span class="source-tag manual">\${esc(s.key)}</span>
        <div class="source-info">
          <div class="source-name">\${esc(s.name)}</div>
          <div class="source-url">\${esc(s.api)}</div>
        </div>
        <div class="source-actions" style="display:flex;gap:6px">
          <button class="btn btn-sm" onclick="validateMC('\${esc(s.api)}')">\${t('test')}</button>
          <button class="btn btn-sm btn-danger" onclick="removeMC('\${esc(s.key)}')">\${t('remove')}</button>
        </div>
      </div>
    \`).join('');
  } catch {
    list.innerHTML = '<div class="empty">' + t('failedLoadMacCMS') + '</div>';
  }
}

async function addMacCMS() {
  const key = $('mcKey').value.trim();
  const name = $('mcName').value.trim();
  const api = $('mcApi').value.trim();
  if (!key || !name || !api) { toast(t('allFieldsRequired'), 'error'); return; }

  const btn = $('mcAddBtn');
  btn.textContent = t('adding');
  btn.className = 'btn loading';

  try {
    const res = await auth.authFetch('/admin/maccms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, name, api })
    });
    const d = await res.json();
    if (res.ok) {
      toast('Added ' + (d.added || 1) + ' MacCMS source(s)');
      $('mcKey').value = '';
      $('mcName').value = '';
      $('mcApi').value = '';
      loadMacCMS();
    } else {
      toast(d.error || 'Failed', 'error');
    }
  } catch { toast(t('networkError'), 'error'); }

  btn.textContent = t('add');
  btn.className = 'btn';
}

async function removeMC(key) {
  try {
    const res = await auth.authFetch('/admin/maccms', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    if (res.ok) { toast('Removed'); loadMacCMS(); }
    else { const d = await res.json(); toast(d.error || 'Failed', 'error'); }
  } catch { toast(t('networkError'), 'error'); }
}

async function validateMC(api) {
  toast(t('testing'));
  try {
    const res = await auth.authFetch('/admin/maccms/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api })
    });
    const d = await res.json();
    toast(d.valid ? t('valid') : t('invalidUnreachable'), d.valid ? 'success' : 'error');
  } catch { toast(t('networkError'), 'error'); }
}

async function batchImportMacCMS() {
  const raw = $('mcBatchInput').value.trim();
  if (!raw) return;
  let data;
  try { data = JSON.parse(raw); } catch { toast(t('invalidJson'), 'error'); return; }
  if (!Array.isArray(data)) { toast(t('mustBeArray'), 'error'); return; }

  try {
    const res = await auth.authFetch('/admin/maccms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const d = await res.json();
    if (res.ok) {
      toast('Imported ' + (d.added || 0) + ' source(s)');
      $('mcBatchInput').value = '';
      loadMacCMS();
    } else {
      toast(d.error || t('importFailed'), 'error');
    }
  } catch { toast(t('networkError'), 'error'); }
}

// --- Live Sources ---
async function loadLives() {
  const list = $('liveList');
  try {
    const res = await auth.authFetch('/admin/lives');
    const entries = await res.json();
    $('liveCount').textContent = entries.length;
    $('badgeLive').textContent = entries.length;

    if (entries.length === 0) {
      list.innerHTML = '<div class="empty">' + t('noLives') + '</div>';
      return;
    }

    list.innerHTML = entries.map(s => \`
      <div class="source-item">
        <span class="source-tag manual">LIVE</span>
        <div class="source-info">
          <div class="source-name">\${esc(s.name || 'Unnamed')}</div>
          <div class="source-url">\${esc(s.url)}</div>
        </div>
        <div class="source-actions">
          <button class="btn btn-sm btn-danger" onclick="removeLive('\${esc(s.url)}')">\${t('remove')}</button>
        </div>
      </div>
    \`).join('');
  } catch {
    list.innerHTML = '<div class="empty">' + t('failedLoadLives') + '</div>';
  }
}

async function addLive() {
  const url = $('liveUrl').value.trim();
  if (!url) { $('liveUrl').focus(); return; }
  const name = $('liveName').value.trim() || '';

  const btn = $('liveAddBtn');
  btn.textContent = t('adding');
  btn.className = 'btn loading';

  try {
    const res = await auth.authFetch('/admin/lives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url })
    });
    const d = await res.json();
    if (res.ok) {
      toast(t('liveSourceAdded'));
      $('liveUrl').value = '';
      $('liveName').value = '';
      loadLives();
    } else {
      toast(d.error || 'Failed to add', 'error');
    }
  } catch {
    toast(t('networkError'), 'error');
  }

  btn.textContent = t('add');
  btn.className = 'btn';
}

async function removeLive(url) {
  try {
    const res = await auth.authFetch('/admin/lives', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (res.ok) { toast(t('removed')); loadLives(); }
    else { const d = await res.json(); toast(d.error || 'Failed', 'error'); }
  } catch { toast(t('networkError'), 'error'); }
}

// --- Import Config ---
async function importConfig() {
  const input = $('importInput').value.trim();
  if (!input) { $('importInput').focus(); return; }

  const btn = $('importBtn');
  const result = $('importResult');
  btn.textContent = t('importing');
  btn.className = 'btn btn-sm loading';
  result.textContent = '';

  try {
    const res = await auth.authFetch('/admin/sources/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input })
    });
    const d = await res.json();
    if (res.ok) {
      const typeLabel = d.type === 'multi' ? t('importMulti') : t('importSingle');
      result.textContent = typeLabel + ': ' + d.added + ' ' + t('importAdded') + (d.duplicates > 0 ? ', ' + d.duplicates + ' ' + t('importDuplicates') : '');
      result.className = 'status-text success';
      if (d.added > 0) {
        $('importInput').value = '';
        loadSources();
      }
    } else {
      result.textContent = d.error || t('importParseFailed');
      result.className = 'status-text error';
    }
  } catch {
    result.textContent = t('networkError');
    result.className = 'status-text error';
  }

  btn.textContent = t('import');
  btn.className = 'btn btn-sm';
}

// --- Name Transform ---
async function loadNameTransform() {
  try {
    const res = await auth.authFetch('/admin/name-transform');
    if (!res.ok) return;
    const d = await res.json();
    $('ntPrefix').value = d.prefix || '';
    $('ntSuffix').value = d.suffix || '';
    $('ntPromoReplace').value = d.promoReplacement || '';
    $('ntExtraPatterns').value = (d.extraCleanPatterns || []).join('\\n');
  } catch {}
}

async function saveNameTransform() {
  const btn = $('ntSaveBtn');
  const status = $('ntStatus');
  btn.textContent = t('saving');
  btn.className = 'btn loading';
  status.textContent = '';

  const extraRaw = $('ntExtraPatterns').value.trim();
  const extraCleanPatterns = extraRaw ? extraRaw.split('\\n').map(s => s.trim()).filter(Boolean) : [];

  try {
    const res = await auth.authFetch('/admin/name-transform', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prefix: $('ntPrefix').value || '',
        suffix: $('ntSuffix').value || '',
        promoReplacement: $('ntPromoReplace').value || '',
        extraCleanPatterns
      })
    });
    const d = await res.json();
    if (res.ok) {
      status.textContent = t('saved');
      status.className = 'status-text success';
    } else {
      status.textContent = d.error || t('saveFailed');
      status.className = 'status-text error';
    }
  } catch {
    status.textContent = t('networkError');
    status.className = 'status-text error';
  }

  btn.textContent = t('save');
  btn.className = 'btn';
  setTimeout(() => { status.textContent = ''; }, 3000);
}

// --- Cron Interval ---
async function loadCronInterval() {
  try {
    const res = await auth.authFetch('/admin/cron-interval');
    if (!res.ok) return;
    const d = await res.json();
    $('cronSelect').value = String(d.interval || 1440);
  } catch {}
}

async function saveCronInterval() {
  const btn = $('cronSaveBtn');
  const status = $('cronStatus');
  btn.textContent = t('saving');
  btn.className = 'btn btn-sm loading';
  status.textContent = '';

  try {
    const res = await auth.authFetch('/admin/cron-interval', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval: parseInt($('cronSelect').value) })
    });
    const d = await res.json();
    if (res.ok) {
      status.textContent = t('saved');
      status.className = 'status-text success';
    } else {
      status.textContent = d.error || t('saveFailed');
      status.className = 'status-text error';
    }
  } catch {
    status.textContent = t('networkError');
    status.className = 'status-text error';
  }

  btn.textContent = t('save');
  btn.className = 'btn btn-sm';
  setTimeout(() => { status.textContent = ''; }, 3000);
}

// --- Speed Test Toggle ---
async function loadSpeedTest() {
  try {
    const res = await auth.authFetch('/admin/speed-test');
    if (res.ok) {
      const d = await res.json();
      $('speedTestCheck').checked = d.enabled;
    }
  } catch {}
}

async function saveSpeedTest() {
  const status = $('speedTestStatus');
  const enabled = $('speedTestCheck').checked;
  status.textContent = '';

  try {
    const res = await auth.authFetch('/admin/speed-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    if (res.ok) {
      status.textContent = t('saved');
      status.className = 'status-text success';
    } else {
      const d = await res.json();
      status.textContent = d.error || t('saveFailed');
      status.className = 'status-text error';
    }
  } catch {
    status.textContent = t('networkError');
    status.className = 'status-text error';
  }

  setTimeout(() => { status.textContent = ''; }, 3000);
}

// --- Channel Probe (Node/Docker) ---
async function loadChannelProbe() {
  const box = $('channelProbeStatus');
  try {
    const res = await auth.authFetch('/admin/channel-probe/status');
    if (res.status === 404) {
      $('channelProbeSection').style.display = 'none';
      return;
    }
    if (!res.ok) {
      box.textContent = t('channelProbeCfOnly');
      return;
    }
    const d = await res.json();
    $('channelProbeCheck').checked = !!d.enabled;
    const s = d.status || {};
    const stateLabel = { idle: t('channelProbeIdle'), running: t('channelProbeRunning'), done: t('channelProbeDone'), partial: t('channelProbePartial'), error: t('channelProbeError') }[s.state] || s.state || '-';
    const lines = [];
    lines.push(t('channelProbeState') + ': ' + stateLabel + (d.running ? ' ⏳' : ''));
    if (s.totalUrls) {
      lines.push(t('channelProbeProgress') + ': ' + (s.probed || 0) + ' / ' + s.totalUrls + ' | ' + t('channelProbeCoverage') + ': ' + (s.coverage || 0) + '% | ' + t('channelProbeChannels') + ': ' + (s.totalChannels || 0));
    }
    if (s.pending) {
      lines.push(t('channelProbePending') + ': ' + s.pending);
    }
    if (s.durationMs) {
      lines.push(t('channelProbeDuration') + ': ' + (s.durationMs / 1000).toFixed(1) + 's');
    }
    const restoreBtn = $('channelProbeRestoreBtn');
    if (restoreBtn) restoreBtn.style.display = (d.deadListed > 0) ? '' : 'none';
    if (typeof d.deadListed === 'number' && d.deadListed > 0) {
      lines.push(t('channelProbeDeadListed') + ': ' + d.deadListed);
    }
    if (s.finishedAt) {
      lines.push(t('channelProbeFinished') + ': ' + new Date(s.finishedAt).toLocaleString());
    }
    if (s.error) {
      lines.push('⚠️ ' + s.error);
    }
    box.innerHTML = lines.map(l => '<div>' + l.replace(/</g,'&lt;') + '</div>').join('');
  } catch {
    box.textContent = t('networkError');
  }
}

async function toggleChannelProbe() {
  const enabled = $('channelProbeCheck').checked;
  try {
    await auth.authFetch('/admin/channel-probe/toggle', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    toast(t('saved'));
    loadChannelProbe();
  } catch {
    toast(t('networkError'), 'error');
  }
}

async function triggerChannelProbe() {
  const btn = $('channelProbeTriggerBtn');
  btn.disabled = true;
  try {
    const res = await auth.authFetch('/admin/channel-probe/trigger', { method: 'POST' });
    const d = await res.json();
    if (res.ok) {
      toast(t('channelProbeStarted'));
      setTimeout(loadChannelProbe, 500);
    } else {
      toast(d.error || 'Failed', 'error');
    }
  } catch {
    toast(t('networkError'), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function dropDeadSources() {
  const btn = $('channelProbeDropBtn');
  if (!confirm(t('channelProbeDropConfirm'))) return;
  btn.disabled = true;
  try {
    const res = await auth.authFetch('/admin/channel-probe/drop-dead', { method: 'POST' });
    const d = await res.json();
    if (res.ok) {
      toast(t('channelProbeDropped').replace('{n}', d.removed ?? 0));
      setTimeout(loadChannelProbe, 500);
    } else {
      toast(d.error || 'Failed', 'error');
    }
  } catch {
    toast(t('networkError'), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function restoreDeadSources() {
  if (!confirm(t('channelProbeRestoreConfirm'))) return;
  try {
    const res = await auth.authFetch('/admin/channel-probe/drop-dead', { method: 'DELETE' });
    const d = await res.json();
    if (res.ok) {
      toast(t('channelProbeRestored').replace('{n}', d.cleared ?? 0));
      setTimeout(loadChannelProbe, 500);
    } else {
      toast(d.error || 'Failed', 'error');
    }
  } catch {
    toast(t('networkError'), 'error');
  }
}


// --- FTP 对外发布 ---
async function loadFtpSync() {
  try {
    const res = await auth.authFetch('/admin/ftp-sync');
    if (!res.ok) return;
    const d = await res.json();
    $('ftpEnabled').checked = !!d.enabled;
    $('ftpHost').value = d.host || '';
    $('ftpPort').value = d.port || 21;
    $('ftpUser').value = d.user || '';
    $('ftpPath').value = d.remotePath || '/live.txt';
    $('ftpPublic').value = d.publicUrl || '';
    $('ftpSecure').checked = !!d.secure;
    $('ftpPass').value = '';
    $('ftpPass').placeholder = d.hasPassword ? t('ftpPassKeep') : '';
  } catch (e) { /* ignore */ }
}

function ftpFormBody() {
  return JSON.stringify({
    enabled: $('ftpEnabled').checked,
    host: $('ftpHost').value.trim(),
    port: parseInt($('ftpPort').value) || 21,
    user: $('ftpUser').value.trim(),
    password: $('ftpPass').value,
    remotePath: $('ftpPath').value.trim() || '/live.txt',
    publicUrl: $('ftpPublic').value.trim(),
    secure: $('ftpSecure').checked
  });
}

async function saveFtpSync() {
  const st = $('ftpStatus');
  try {
    const res = await auth.authFetch('/admin/ftp-sync', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: ftpFormBody()
    });
    if (res.ok) { st.textContent = t('saved'); st.style.color = 'var(--success,#1D9E75)'; setTimeout(loadFtpSync, 800); }
    else { st.textContent = 'Failed'; st.style.color = 'var(--danger,#A32D2D)'; }
  } catch (e) { st.textContent = t('networkError'); }
}

async function testFtpSync() {
  const st = $('ftpStatus');
  st.textContent = t('ftpTesting');
  try {
    const res = await auth.authFetch('/admin/ftp-sync/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ftpFormBody()
    });
    const d = await res.json();
    if (d.ok) {
      const parts = [t('ftpTestOk')];
      if (d.pwd) parts.push('目录 ' + d.pwd);
      parts.push(d.writable ? t('ftpWritable') : (t('ftpNotWritable') + (d.note ? '（' + d.note + '）' : '')));
      if (d.files && d.files.length) parts.push(d.files.slice(0, 6).join(', '));
      st.textContent = parts.join(' | ');
      st.style.color = d.writable ? 'var(--success,#1D9E75)' : 'var(--danger,#A32D2D)';
    } else {
      st.textContent = t('ftpTestFail') + ': ' + (d.error || '');
      st.style.color = 'var(--danger,#A32D2D)';
    }
  } catch (e) { st.textContent = t('networkError'); }
}

async function runFtpSync() {
  const st = $('ftpStatus');
  st.textContent = t('ftpUploading');
  try {
    const res = await auth.authFetch('/admin/ftp-sync/run', { method: 'POST' });
    const d = await res.json();
    if (d.ok) { st.textContent = t('ftpUploadOk').replace('{n}', d.bytes || 0); st.style.color = 'var(--success,#1D9E75)'; }
    else { st.textContent = t('ftpUploadFail') + ': ' + (d.error || ''); st.style.color = 'var(--danger,#A32D2D)'; }
  } catch (e) { st.textContent = t('networkError'); }
}

// --- 购物台过滤 ---
let shoppingCfg = null;

async function loadShoppingFilter() {
  try {
    const res = await auth.authFetch('/admin/live-shopping');
    if (!res.ok) return;
    shoppingCfg = await res.json();
    const cb = $('shoppingFilterCheck');
    if (cb) cb.checked = !!shoppingCfg.enabled;
    const kw = $('shoppingKeywords');
    if (kw) kw.value = (shoppingCfg.keywords || []).join(', ');
  } catch (e) { /* ignore */ }
}

async function saveShoppingFilter() {
  const kwEl = $('shoppingKeywords');
  const keywords = kwEl ? kwEl.value.split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean) : [];
  const st = $('shoppingFilterStatus');
  try {
    const res = await auth.authFetch('/admin/live-shopping', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: $('shoppingFilterCheck').checked, keywords: keywords })
    });
    const d = await res.json();
    if (res.ok) {
      st.textContent = t('saved') + ' (' + d.keywords + ')';
      st.style.color = 'var(--success,#1D9E75)';
    } else {
      st.textContent = d.error || 'Failed';
      st.style.color = 'var(--danger,#A32D2D)';
    }
  } catch (e) { st.textContent = t('networkError'); }
}

// --- 是否采用配置源 lives ---
async function loadUseConfigLives() {
  try {
    const res = await auth.authFetch('/admin/live-use-config-lives');
    if (!res.ok) return;
    const d = await res.json();
    const cb = $('useConfigLivesCheck');
    if (cb) cb.checked = !!d.enabled;
  } catch (e) { /* ignore */ }
}

async function saveUseConfigLives() {
  try {
    const res = await auth.authFetch('/admin/live-use-config-lives', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: $('useConfigLivesCheck').checked })
    });
    if (res.ok) $('useConfigLivesStatus').textContent = t('saved');
  } catch (e) { /* ignore */ }
}

// --- 测速分片复验 ---
async function loadProbeSegment() {
  try {
    const res = await auth.authFetch('/admin/channel-probe/segment');
    if (!res.ok) return;
    const d = await res.json();
    const cb = $('probeSegmentCheck');
    if (cb) cb.checked = !!d.enabled;
  } catch (e) { /* ignore */ }
}

async function saveProbeSegment() {
  try {
    await auth.authFetch('/admin/channel-probe/segment', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: $('probeSegmentCheck').checked })
    });
  } catch (e) { /* ignore */ }
}

async function clearProbeCache() {
  if (!confirm(t('probeClearCacheConfirm'))) return;
  try {
    const res = await auth.authFetch('/admin/channel-probe/clear-cache', { method: 'POST' });
    const d = await res.json();
    if (d.success) toast(t('probeClearCacheDone').replace('{n}', d.cleared || 0));
    else toast(d.error || 'Failed', 'error');
  } catch (e) { toast(t('networkError'), 'error'); }
}

// --- 测速并入聚合 ---
async function loadProbeInline() {
  try {
    const res = await auth.authFetch('/admin/channel-probe/inline');
    if (!res.ok) return;
    const d = await res.json();
    const cb = $('probeInlineCheck');
    if (cb) cb.checked = !!d.enabled;
  } catch (e) { /* ignore */ }
}

async function saveProbeInline() {
  try {
    await auth.authFetch('/admin/channel-probe/inline', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: $('probeInlineCheck').checked })
    });
  } catch (e) { /* ignore */ }
}

// --- Live Group Merge (分组归并) ---
let liveGroupData = null;

async function loadLiveGroups() {
  const box = $('groupMergeRules');
  if (!box) return;
  try {
    const res = await auth.authFetch('/admin/live-groups');
    if (!res.ok) return;
    liveGroupData = await res.json();
    $('groupMergeEnabled').checked = !!liveGroupData.enabled;
    box.value = (liveGroupData.rules || []).map(function (r) { return r.keyword + '=' + r.target; }).join('\\n');
  } catch (e) { /* ignore */ }
}

async function saveLiveGroups() {
  const box = $('groupMergeRules');
  const rules = box.value.split('\\n').map(function (line) {
    const i = line.indexOf('=');
    if (i <= 0) return null;
    return { keyword: line.slice(0, i).trim(), target: line.slice(i + 1).trim() };
  }).filter(function (r) { return r && r.keyword && r.target; });

  const st = $('groupMergeStatus');
  try {
    const res = await auth.authFetch('/admin/live-groups', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: $('groupMergeEnabled').checked, rules: rules })
    });
    const d = await res.json();
    if (res.ok) {
      st.textContent = t('groupMergeSaved') + ' (' + d.rules + ' 条规则)';
      st.style.color = 'var(--success,#1D9E75)';
      setTimeout(function () { loadChannelOrder(); }, 1200);
    } else {
      st.textContent = d.error || 'Failed';
      st.style.color = 'var(--danger,#A32D2D)';
    }
  } catch (e) {
    st.textContent = t('networkError');
  }
}

async function resetLiveGroups() {
  if (!confirm(t('groupMergeResetConfirm'))) return;
  try {
    const res = await auth.authFetch('/admin/live-groups/reset', { method: 'POST' });
    if (res.ok) {
      $('groupMergeStatus').textContent = t('groupMergeResetDone');
      setTimeout(loadLiveGroups, 1200);
    }
  } catch (e) { /* ignore */ }
}

// --- 站点跳过名单（保留链接模式） ---
async function loadKeepLink() {
  try {
    const res = await auth.authFetch('/admin/site-keep-link');
    if (!res.ok) return;
    const d = await res.json();
    const sel = $('autoCleanMode');
    if (sel) sel.value = d.enabled ? 'keep' : 'delete';
    const st = $('keepLinkStatus');
    if (st) st.textContent = d.skipped > 0 ? t('skipCount').replace('{n}', d.skipped) : '';
  } catch (e) { /* ignore */ }
}

async function saveKeepLink() {
  try {
    const res = await auth.authFetch('/admin/site-keep-link', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: $('autoCleanMode').value === 'keep' })
    });
    if (res.ok) {
      $('keepLinkStatus').textContent = t('saved');
      setTimeout(loadKeepLink, 1200);
    }
  } catch (e) { /* ignore */ }
}

async function clearSkipList() {
  if (!confirm(t('clearSkipConfirm'))) return;
  try {
    const res = await auth.authFetch('/admin/site-keep-link', { method: 'DELETE' });
    if (res.ok) {
      $('keepLinkStatus').textContent = t('clearSkipDone');
      setTimeout(loadKeepLink, 1200);
    }
  } catch (e) { /* ignore */ }
}

// --- 频道与源（固化框架） ---
let channelsData = null;
let channelCurrentGroup = null;

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function tierBadge(h) {
  if (!h || !h.samples) return '<span style="color:var(--text-secondary)">未测</span>';
  if (h.tier === 0) return '<span style="color:var(--success,#1D9E75)">健康</span>';
  if (h.tier === 1) return '<span style="color:var(--warning,#BA7517)">观察</span>';
  return '<span style="color:var(--danger,#A32D2D)">隔离</span>';
}

async function loadChannels() {
  const box = $('channelTable');
  if (!box) return;
  try {
    const res = await auth.authFetch('/admin/channels');
    if (!res.ok) { box.textContent = t('channelOrderNeedRefresh'); return; }
    channelsData = await res.json();
    if (!channelCurrentGroup && channelsData.groups && channelsData.groups.length) {
      channelCurrentGroup = channelsData.groups[0].group;
    }
    renderChannelGroups();
    renderChannelTable();
    renderUnmapped();
  } catch (e) {
    box.textContent = t('networkError');
  }
}

function renderChannelGroups() {
  const box = $('channelGroupList');
  if (!box || !channelsData) return;
  box.innerHTML = '';
  (channelsData.groups || []).forEach(function (g) {
    const row = document.createElement('div');
    const active = g.group === channelCurrentGroup;
    row.style.cssText = 'padding:6px 8px;border-radius:6px;cursor:pointer;font-size:.85rem;display:flex;justify-content:space-between;' +
      (active ? 'background:var(--accent,#378ADD);color:#fff' : '');
    const n = document.createElement('span'); n.textContent = g.group;
    const cnt = document.createElement('span'); cnt.textContent = String((g.channels || []).length);
    cnt.style.cssText = 'opacity:.7;font-size:.75rem';
    row.appendChild(n); row.appendChild(cnt);
    row.addEventListener('click', function () { channelCurrentGroup = g.group; renderChannelGroups(); renderChannelTable(); });
    box.appendChild(row);
  });
}

function renderChannelTable() {
  const box = $('channelTable');
  const sum = $('channelSummary');
  if (!box || !channelsData) return;
  const g = (channelsData.groups || []).find(function (x) { return x.group === channelCurrentGroup; });
  const chans = g ? g.channels || [] : [];
  let totSources = 0;
  (channelsData.groups || []).forEach(function (x) {
    (x.channels || []).forEach(function (ch) { totSources += (ch.urls || []).length; });
  });
  if (sum) {
    sum.textContent = '目录 ' + (channelsData.registrySize || 0) + ' 个频道 · 输出 ' +
      (channelsData.groups || []).reduce(function (n, x) { return n + (x.channels || []).length; }, 0) +
      ' 个 · ' + totSources + ' 条源 · 未识别 ' + ((channelsData.unmapped || []).length) + ' 条';
  }

  const rows = chans.map(function (ch) {
    const first = (ch.urls || [])[0] || {};
    const h = first.health || {};
    const avail = h.availability != null ? Math.round(h.availability * 100) + '%' : '-';
    const detail = (ch.urls || []).map(function (u, i) {
      return '<div style="display:flex;justify-content:space-between;gap:8px;padding:2px 0;border-top:1px dashed var(--border)">' +
        '<span style="color:var(--text-secondary);font-size:.72rem">' + (i + 1) + '</span>' +
        '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.72rem">' + esc(u.url) + '</span>' +
        '<span style="font-size:.72rem;color:var(--text-secondary)">' + (u.kind === 'fail' ? (u.note || '不可用') : (u.speedMs + 'ms')) + '</span>' +
        '<a href="javascript:void(0)" data-url="' + esc(u.url) + '" onclick="deleteSource(this.dataset.url)" style="font-size:.72rem;color:var(--danger,#A32D2D)">删</a>' +
        '</div>';
    }).join('');
    return '<details style="border-bottom:1px solid var(--border)">' +
      '<summary style="display:flex;gap:10px;align-items:center;padding:6px 8px;cursor:pointer;font-size:.82rem">' +
      '<span style="min-width:130px">' + esc(ch.name) +
      (ch.pinned ? ' <b style="color:var(--accent,#378ADD);font-size:.7rem">顶</b>' : '') +
      (ch.disabled ? ' <b style="color:var(--danger,#A32D2D);font-size:.7rem">停</b>' : '') + '</span>' +
      '<span style="min-width:80px;color:var(--text-secondary);font-size:.72rem">' + esc(ch.id || '-') + '</span>' +
      '<a href="javascript:void(0)" data-name="' + esc(ch.name) + '" data-flag="pinned" onclick="toggleOverride(this)" style="font-size:.7rem;color:var(--text-secondary);white-space:nowrap">' + (ch.pinned ? '取消置顶' : '置顶') + '</a>' +
      '<a href="javascript:void(0)" data-name="' + esc(ch.name) + '" data-flag="disabled" onclick="toggleOverride(this)" style="font-size:.7rem;color:var(--text-secondary);white-space:nowrap">' + (ch.disabled ? '启用' : '禁用') + '</a>' +
      '<span style="min-width:46px;color:var(--text-secondary)">' + (ch.urls || []).length + ' 源</span>' +
      '<span style="min-width:60px">' + (first.kind === 'fail' ? '-' : (first.speedMs + 'ms')) + '</span>' +
      '<span style="min-width:52px">' + tierBadge(h) + '</span>' +
      '<span style="color:var(--text-secondary);font-size:.72rem">' + avail + '</span>' +
      '</summary><div style="padding:0 8px 8px 8px">' + detail + '</div></details>';
  }).join('');
  box.innerHTML = rows || '<div style="padding:10px;font-size:.82rem;color:var(--text-secondary)">该分组暂无频道</div>';
}

function renderUnmapped() {
  const box = $('unmappedList');
  if (!box || !channelsData) return;
  const list = channelsData.unmapped || [];
  channelUnmappedList = list;
  if (!list.length) { box.innerHTML = '<span style="color:var(--text-secondary)">没有未识别频道</span>'; return; }

  // 目标频道候选：把当前树里所有「有 id 的频道」放进 datalist，输入时自动补全
  const optSeen = {};
  const options = [];
  (channelsData.groups || []).forEach(function (g) {
    (g.channels || []).forEach(function (ch) {
      if (!ch.id || optSeen[ch.id]) return;
      optSeen[ch.id] = 1;
      options.push('<option value="' + esc(ch.id) + '">' + esc(ch.name) + ' · ' + esc(g.group) + '</option>');
    });
  });

  box.innerHTML = list.slice(0, 200).map(function (u, i) {
    return '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border)">' +
      '<span style="flex:1;min-width:120px">' + esc(u.name) +
      ' <span style="color:var(--text-secondary);font-size:.72rem">' + esc(u.group) + ' · ' + u.urls + ' 源</span></span>' +
      '<input id="unmappedTarget' + i + '" list="chIdList" placeholder="目标频道 id" style="width:180px;padding:3px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary);font-size:.75rem">' +
      '<button class="btn btn-sm" data-idx="' + i + '" onclick="assignUnmapped(this.dataset.idx)">归入</button>' +
      '<a href="javascript:void(0)" data-name="' + esc(u.name) + '" data-flag="disabled" onclick="toggleOverride(this)" style="font-size:.72rem;color:var(--danger,#A32D2D);white-space:nowrap">忽略</a>' +
      '</div>';
  }).join('') + '<datalist id="chIdList">' + options.join('') + '</datalist>';
}

let channelUnmappedList = [];

async function assignUnmapped(idx) {
  const u = channelUnmappedList[Number(idx)];
  const input = $('unmappedTarget' + idx);
  if (!u || !input || !input.value.trim()) return;
  try {
    const res = await auth.authFetch('/admin/channels/assign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: u.name, id: input.value.trim() }),
    });
    if (res.ok) { input.value = '✓'; setTimeout(loadChannels, 600); }
    else { const d = await res.json().catch(function () { return {}; }); input.value = d.error || '失败'; }
  } catch (e) { input.value = t('networkError'); }
}

/** 置顶 / 禁用 / 忽略：三处按钮共用，data-flag 决定动作 */
async function toggleOverride(el) {
  const name = el.dataset.name;
  const flag = el.dataset.flag;
  if (!name || !flag) return;
  // 当前状态从行内文本反推（按钮文字就是开关状态）
  const on = (flag === 'disabled') ? (el.textContent === '启用') : (el.textContent === '取消置顶');
  const body = { name: name };
  body[flag] = !on;
  // 禁用时顺手取消置顶，避免「既置顶又禁用」的脏状态
  if (flag === 'disabled' && !on) body.pinned = false;
  try {
    const res = await auth.authFetch('/admin/channels/override', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (res.ok) setTimeout(loadChannels, 400);
  } catch (e) { /* ignore */ }
}

async function optimizeChannels() {
  const n = parseInt(($('topNInput') || {}).value, 10) || 6;
  const st = $('channelsStatus');
  if (!confirm(t('channelsOptimizeConfirm').replace('{n}', n))) return;
  try {
    const res = await auth.authFetch('/admin/channels/optimize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topN: n }),
    });
    const d = await res.json();
    if (res.ok) {
      if (st) st.textContent = t('channelsOptimizeDone').replace('{n}', d.topN);
      setTimeout(loadChannels, 1500);
    } else if (st) st.textContent = d.error || 'Failed';
  } catch (e) { if (st) st.textContent = t('networkError'); }
}

async function deleteSource(url) {
  if (!confirm(t('channelsDeleteConfirm'))) return;
  try {
    const res = await auth.authFetch('/admin/channels/source', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: [url] }),
    });
    if (res.ok) { toast(t('channelsDeleted')); setTimeout(loadChannels, 1200); }
  } catch (e) { toast(t('networkError'), 'error'); }
}

// --- 源健康 ---
async function loadHealth() {
  try {
    const [sRes, dRes, rRes] = await Promise.all([
      auth.authFetch('/admin/health/summary'),
      auth.authFetch('/admin/health/domains?limit=40'),
      auth.authFetch('/admin/health/reasons'),
    ]);
    if (!sRes.ok) return;
    const s = await sRes.json();
    const doms = dRes.ok ? await dRes.json() : [];
    const reasons = rRes.ok ? await rRes.json() : [];

    const sum = $('healthSummary');
    if (sum) {
      const cell = function (label, value, color) {
        return '<div><div style="color:var(--text-secondary);font-size:.72rem">' + label + '</div>' +
          '<div style="font-size:1.1rem;' + (color ? 'color:' + color : '') + '">' + value + '</div></div>';
      };
      sum.innerHTML = [
        cell('源总数', s.total),
        cell('可用', s.ok + ' (' + Math.round(s.okRate * 100) + '%)', 'var(--success,#1D9E75)'),
        cell('不可用', s.dead, 'var(--danger,#A32D2D)'),
        cell('连续失败', s.isolated, 'var(--warning,#BA7517)'),
        cell('域名', s.domains),
      ].join('');
    }

    const dbox = $('healthDomains');
    if (dbox) {
      dbox.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:.8rem">' +
        '<thead><tr style="text-align:left;color:var(--text-secondary)"><th style="padding:6px">域名</th><th>源</th><th>可用率</th><th>平均延迟</th></tr></thead><tbody>' +
        doms.map(function (d) {
          const rate = Math.round(d.okRate * 100);
          return '<tr style="border-top:1px solid var(--border)"><td style="padding:5px 6px">' + esc(d.host) + '</td>' +
            '<td>' + d.sources + '</td>' +
            '<td style="color:' + (rate < 30 ? 'var(--danger,#A32D2D)' : rate < 70 ? 'var(--warning,#BA7517)' : 'var(--success,#1D9E75)') + '">' + rate + '%</td>' +
            '<td>' + (d.avgMs || '-') + 'ms</td></tr>';
        }).join('') + '</tbody></table>';
    }

    const rbox = $('healthReasons');
    if (rbox) {
      rbox.innerHTML = reasons.length
        ? reasons.map(function (r) { return '<div style="padding:2px 0">' + esc(r.reason) + ' <span style="color:var(--text-secondary)">× ' + r.count + '</span></div>'; }).join('')
        : '<span style="color:var(--text-secondary)">暂无失败记录</span>';
    }
  } catch (e) { /* ignore */ }
  loadHosts();
  loadHeadVerify();
}

// --- 域名台账 ---
async function loadHosts() {
  const statsBox = $('hostStats');
  const table = $('hostTable');
  if (!statsBox || !table) return;
  try {
    const res = await auth.authFetch('/admin/channel-probe/hosts');
    if (!res.ok) { table.innerHTML = '<span style="color:var(--text-secondary)">读取失败</span>'; return; }
    const d = await res.json();
    const cell = function (label, value, color) {
      return '<div><div style="color:var(--text-secondary);font-size:.72rem">' + label + '</div>' +
        '<div style="font-size:1.05rem;' + (color ? 'color:' + color : '') + '">' + value + '</div></div>';
    };
    statsBox.innerHTML = [
      cell('树里域名', d.treeHosts),
      cell('已入档', d.total),
      cell('可疑', d.suspect, 'var(--warning,#BA7517)'),
      cell('判死', d.condemned, 'var(--danger,#A32D2D)'),
      cell('覆盖源', d.coveredUrls),
      cell('本周待测', d.due),
    ].join('');
    table.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:.8rem">' +
      '<thead><tr style="text-align:left;color:var(--text-secondary)"><th style="padding:6px">域名</th><th>状态</th><th>源</th><th>已入档</th></tr></thead><tbody>' +
      (d.top || []).map(function (h) {
        return '<tr style="border-top:1px solid var(--border)">' +
          '<td style="padding:5px 6px">' + esc(h.host) + '</td>' +
          '<td style="color:' + (h.state === 2 ? 'var(--danger,#A32D2D)' : 'var(--warning,#BA7517)') + '">' + (h.state === 2 ? '判死' : '可疑') + '</td>' +
          '<td>' + h.urls + '</td>' +
          '<td>' + (h.sinceDays || 0) + ' 天</td></tr>';
      }).join('') + '</tbody></table>';
  } catch (e) { /* ignore */ }
}

async function reseedHosts() {
  const st = $('hostStatus');
  if (!confirm(t('hostLedgerReseedConfirm'))) return;
  if (st) st.textContent = '...';
  try {
    const res = await auth.authFetch('/admin/channel-probe/hosts/reseed', { method: 'POST' });
    const d = await res.json();
    if (st) st.textContent = res.ok ? ('新增 ' + d.added + ' / 共 ' + d.total) : (d.error || '失败');
    if (res.ok) loadHosts();
  } catch (e) { if (st) st.textContent = t('networkError'); }
}

// --- 首位复核开关 ---
async function loadHeadVerify() {
  const box = $('headVerifyCheck');
  if (!box) return;
  try {
    const res = await auth.authFetch('/admin/live-head-verify');
    if (!res.ok) return;
    const d = await res.json();
    box.checked = !!d.enabled;
  } catch (e) { /* ignore */ }
}

async function saveHeadVerify() {
  const box = $('headVerifyCheck');
  const st = $('headVerifyStatus');
  if (!box) return;
  try {
    const res = await auth.authFetch('/admin/live-head-verify', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: box.checked }),
    });
    if (st) st.textContent = res.ok ? (box.checked ? '已开启' : '已关闭') : '保存失败';
    setTimeout(function () { if (st) st.textContent = ''; }, 2500);
  } catch (e) { if (st) st.textContent = t('networkError'); }
}

// --- Channel Order (频道排序) ---
let channelOrderData = null;
let channelOrderCurrent = null;
let channelOrderDraft = {};
let channelOrderDragIndex = -1;

async function loadChannelOrder() {
  const list = $('channelOrderList');
  if (!list) return;
  try {
    const res = await auth.authFetch('/admin/channel-order');
    if (!res.ok) {
      list.textContent = t('channelOrderNeedRefresh');
      list.style.cssText += ';color:var(--text-secondary);font-size:.85rem';
      return;
    }
    channelOrderData = await res.json();
    channelOrderDraft = {};
    (channelOrderData.groups || []).forEach(function (g) {
      channelOrderDraft[g.group] = g.channels.map(function (c) { return c.name; });
    });
    if (!channelOrderCurrent || !channelOrderDraft[channelOrderCurrent]) {
      channelOrderCurrent = (channelOrderData.groups && channelOrderData.groups[0]) ? channelOrderData.groups[0].group : null;
    }
    renderChannelOrderGroups();
    renderChannelOrderList();
  } catch (e) {
    list.textContent = t('networkError');
  }
}

function renderChannelOrderGroups() {
  const box = $('channelOrderGroups');
  if (!box || !channelOrderData) return;
  box.innerHTML = '';
  (channelOrderData.groups || []).forEach(function (g) {
    const row = document.createElement('div');
    const active = g.group === channelOrderCurrent;
    row.style.cssText = 'padding:6px 8px;border-radius:6px;cursor:pointer;font-size:.85rem;display:flex;justify-content:space-between;align-items:center;' +
      (active ? 'background:var(--accent,#378ADD);color:#fff;' : '');
    const nameEl = document.createElement('span');
    nameEl.textContent = g.group;
    const countEl = document.createElement('span');
    countEl.textContent = String(g.count || 0);
    countEl.style.cssText = 'opacity:.7;font-size:.75rem';
    row.appendChild(nameEl);
    row.appendChild(countEl);
    row.addEventListener('click', function () {
      channelOrderCurrent = g.group;
      renderChannelOrderGroups();
      renderChannelOrderList();
    });
    box.appendChild(row);
  });
}

function renderChannelOrderList() {
  const box = $('channelOrderList');
  if (!box) return;
  box.innerHTML = '';

  const names = channelOrderCurrent ? (channelOrderDraft[channelOrderCurrent] || []) : [];
  if (names.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = t('channelOrderEmpty');
    empty.style.cssText = 'color:var(--text-secondary);font-size:.85rem';
    box.appendChild(empty);
    return;
  }

  const src = (channelOrderData.groups || []).find(function (g) { return g.group === channelOrderCurrent; });
  const urlCount = {};
  if (src) src.channels.forEach(function (c) { urlCount[c.name] = c.urls; });

  names.forEach(function (name, i) {
    const row = document.createElement('div');
    row.draggable = true;
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid var(--border);font-size:.85rem;cursor:grab';

    const left = document.createElement('span');
    const idxEl = document.createElement('span');
    idxEl.textContent = String(i + 1);
    idxEl.style.cssText = 'color:var(--text-secondary);font-family:var(--mono);font-size:.75rem;margin-right:8px';
    left.appendChild(idxEl);
    left.appendChild(document.createTextNode(name));

    const right = document.createElement('span');
    right.textContent = (urlCount[name] != null) ? urlCount[name] + ' 源' : '';
    right.style.cssText = 'color:var(--text-secondary);font-size:.72rem';

    row.appendChild(left);
    row.appendChild(right);

    row.addEventListener('dragstart', function () { channelOrderDragIndex = i; });
    row.addEventListener('dragover', function (e) { e.preventDefault(); });
    row.addEventListener('drop', function (e) {
      e.preventDefault();
      if (!channelOrderCurrent || channelOrderDragIndex < 0 || channelOrderDragIndex === i) return;
      const arr = channelOrderDraft[channelOrderCurrent];
      const moved = arr.splice(channelOrderDragIndex, 1)[0];
      arr.splice(i, 0, moved);
      channelOrderDragIndex = -1;
      renderChannelOrderList();
      setChannelOrderStatus(t('channelOrderDirty'), false);
    });
    row.addEventListener('dragend', function () { channelOrderDragIndex = -1; });

    box.appendChild(row);
  });
}

function setChannelOrderStatus(msg, ok) {
  const el = $('channelOrderStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = ok ? 'var(--success,#1D9E75)' : 'var(--text-secondary)';
}

async function saveChannelOrder() {
  try {
    const res = await auth.authFetch('/admin/channel-order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: channelOrderDraft })
    });
    if (res.ok) { setChannelOrderStatus(t('channelOrderSaved'), true); toast(t('channelOrderSaved')); }
    else { setChannelOrderStatus('保存失败', false); }
  } catch { setChannelOrderStatus(t('networkError'), false); }
}

async function smartSortChannels() {
  setChannelOrderStatus(t('channelOrderSorting'), false);
  try {
    const res = await auth.authFetch('/admin/channel-order/smart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await res.json();
    if (res.ok) {
      const moved = (d.movedOut || []).length;
      setChannelOrderStatus(t('channelOrderSmartDone').replace('{kept}', d.kept || 0).replace('{moved}', moved), true);
      if (moved) toast(t('channelOrderMoved').replace('{list}', d.movedOut.join('、')));
      setTimeout(() => { loadChannelOrder(); loadLiveMergeMode(); }, 1500);
    } else {
      setChannelOrderStatus(d.error || 'Failed', false);
    }
  } catch { setChannelOrderStatus(t('networkError'), false); }
}

async function resetChannelOrder() {
  if (!confirm(t('channelOrderResetConfirm'))) return;
  try {
    const res = await auth.authFetch('/admin/channel-order', { method: 'DELETE' });
    if (res.ok) { setChannelOrderStatus(t('channelOrderResetDone'), true); setTimeout(loadChannelOrder, 1200); }
  } catch { setChannelOrderStatus(t('networkError'), false); }
}

// --- Edge Proxies ---
async function loadEdgeProxies() {
  try {
    const res = await auth.authFetch('/admin/edge-proxies');
    if (res.ok) {
      const d = await res.json();
      $('edgeCfUrl').value = d.cf || '';
      $('edgeVercelUrl').value = d.vercel || '';
    }
  } catch {}
}

async function saveEdgeProxies() {
  const status = $('edgeProxiesStatus');
  try {
    const res = await auth.authFetch('/admin/edge-proxies', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cf: $('edgeCfUrl').value.trim(), vercel: $('edgeVercelUrl').value.trim() })
    });
    if (res.ok) {
      status.textContent = t('saved');
      status.className = 'status-text success';
    } else {
      status.textContent = t('saveFailed');
      status.className = 'status-text error';
    }
  } catch {
    status.textContent = t('networkError');
    status.className = 'status-text error';
  }
  setTimeout(() => { status.textContent = ''; }, 3000);
}


// --- Search Quota ---
let sqPinnedKeys = new Set();

async function loadSearchQuota() {
  try {
    const res = await auth.authFetch('/admin/search-quota');
    if (!res.ok) return;
    const d = await res.json();
    $('maxSearchableInput').value = d.maxSearchable;
    sqPinnedKeys = new Set(d.pinnedKeys || []);
    loadSearchQuotaReport();
  } catch {}
}

async function saveSearchQuota() {
  const status = $('searchQuotaStatus');
  status.textContent = '';
  const data = {
    maxSearchable: parseInt($('maxSearchableInput').value) || 0,
    pinnedKeys: [...sqPinnedKeys],
  };
  try {
    const res = await auth.authFetch('/admin/search-quota', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      status.textContent = t('saved');
      status.className = 'status-text success';
    } else {
      status.textContent = t('saveFailed');
      status.className = 'status-text error';
    }
  } catch {
    status.textContent = t('networkError');
    status.className = 'status-text error';
  }
  setTimeout(() => { status.textContent = ''; }, 3000);
}

async function loadSearchQuotaReport() {
  try {
    const res = await auth.authFetch('/admin/search-quota/report');
    if (!res.ok) return;
    const d = await res.json();
    if (d.searchable == null) return;

    // 显示 Search 页签
    $('tabSearchQuota').style.display = '';
    $('sqSelectedInfo').textContent = d.totalSites + ' sites → ' + d.jsExcluded + ' JS excluded → ' + d.searchable + ' searchable' + (d.truncated > 0 ? ' (' + d.truncated + ' truncated)' : '') + (d.pinnedCount > 0 ? ', ' + d.pinnedCount + ' pinned' : '');
    $('badgeSearchQuota').textContent = d.searchable;

    // 加载站点列表
    const cfgRes = await fetch('/');
    if (!cfgRes.ok) return;
    const cfg = await cfgRes.json();
    const allSites = (cfg.sites || []).filter(s => s.searchable === 1);
    sqAllSites = allSites;
    renderSearchSources();
  } catch {}
}

let sqAllSites = [];

function renderSearchSources() {
  const pinnedArr = [...sqPinnedKeys];
  const siteMap = new Map(sqAllSites.map(s => [s.key, s]));
  let html = '';

  // 1. Pinned 源（有序，可排序）
  if (pinnedArr.length > 0) {
    html += '<div style="margin-bottom:12px"><strong style="color:var(--primary)">' + t('sqPinned') + ' (' + pinnedArr.length + ')</strong>';
    html += ' <span style="font-size:0.75rem;color:var(--text-secondary)">— ' + t('sqPinnedDesc') + '</span></div>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:0.8rem">';
    pinnedArr.forEach((key, i) => {
      const s = siteMap.get(key);
      const name = s ? (s.name || s.key) : key;
      html += '<tr style="border-bottom:1px solid var(--border);background:var(--bg-hover)">';
      html += '<td style="padding:4px;width:30px;color:var(--text-secondary)">' + (i + 1) + '</td>';
      html += '<td style="padding:4px;font-family:var(--mono);font-size:0.75rem">' + escHtml(key) + '</td>';
      html += '<td style="padding:4px">' + escHtml(name) + '</td>';
      html += '<td style="padding:4px;width:100px;text-align:right;white-space:nowrap">';
      if (i > 0) html += '<button class="btn btn-sm" style="padding:1px 6px;font-size:0.7rem" onclick="movePinned(' + i + ',-1)">▲</button> ';
      if (i < pinnedArr.length - 1) html += '<button class="btn btn-sm" style="padding:1px 6px;font-size:0.7rem" onclick="movePinned(' + i + ',1)">▼</button> ';
      html += '<button class="btn btn-sm" style="padding:1px 6px;font-size:0.7rem;color:var(--red)" onclick="togglePin(&quot;' + escHtml(key) + '&quot;)">' + t('sqUnpin') + '</button>';
      html += '</td></tr>';
    });
    html += '</table>';
  }

  // 2. 其他源（可 pin）
  const unpinned = sqAllSites.filter(s => !sqPinnedKeys.has(s.key));
  html += '<div style="margin-top:16px;margin-bottom:8px"><strong>' + t('sqOtherSources') + ' (' + unpinned.length + ')</strong></div>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:0.8rem">';
  unpinned.slice(0, 200).forEach(s => {
    html += '<tr style="border-bottom:1px solid var(--border)">';
    html += '<td style="padding:4px;font-family:var(--mono);font-size:0.75rem">' + escHtml(s.key) + '</td>';
    html += '<td style="padding:4px">' + escHtml(s.name || s.key) + '</td>';
    html += '<td style="padding:4px;width:50px;text-align:right"><button class="btn btn-sm" style="padding:1px 6px;font-size:0.7rem" onclick="togglePin(&quot;' + escHtml(s.key) + '&quot;)">' + t('sqPin') + '</button></td>';
    html += '</tr>';
  });
  if (unpinned.length > 200) html += '<tr><td colspan="3" style="padding:4px;color:var(--text-secondary)">... +' + (unpinned.length - 200) + ' more</td></tr>';
  html += '</table>';

  $('sqSelectedTable').innerHTML = html;
}

async function movePinned(index, direction) {
  const arr = [...sqPinnedKeys];
  const target = index + direction;
  if (target < 0 || target >= arr.length) return;
  [arr[index], arr[target]] = [arr[target], arr[index]];
  try {
    const res = await auth.authFetch('/admin/search-quota/pinned', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: arr }),
    });
    if (res.ok) {
      const d = await res.json();
      sqPinnedKeys = new Set(d.pinnedKeys);
      renderSearchSources();
    }
  } catch {}
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

async function togglePin(key) {
  const isPinned = sqPinnedKeys.has(key);
  try {
    const res = await auth.authFetch('/admin/search-quota/pinned', {
      method: isPinned ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [key] }),
    });
    if (res.ok) {
      const d = await res.json();
      sqPinnedKeys = new Set(d.pinnedKeys);
      renderSearchSources();
    }
  } catch {}
}

// --- Refresh ---
async function triggerRefresh() {
  const btn = $('refreshBtn');
  btn.textContent = t('running');
  btn.className = 'btn btn-sm loading';

  try {
    const res = await auth.authFetch('/refresh', { method: 'POST' });
    const d = await res.json();
    if (d.success) {
      toast(t('aggregationStarted'));
      setTimeout(loadStatus, 3000);
    } else {
      toast(t('refreshFailed'), 'error');
    }
  } catch {
    toast(t('networkError'), 'error');
  }

  setTimeout(() => {
    btn.textContent = t('refresh');
    btn.className = 'btn btn-sm';
  }, 3000);
}

// --- Cloud Credentials ---
const PLATFORM_NAMES = {
  aliyun:'阿里云盘', bilibili:'Bilibili', quark:'夸克网盘', uc:'UC 网盘',
  pan115:'115 网盘', tianyi:'天翼云盘', baidu:'百度网盘', pan123:'123 网盘',
  thunder:'迅雷', pikpak:'PikPak'
};
const QR_PLATFORMS = ['bilibili','aliyun','quark','uc','pan115','tianyi','baidu','pan123'];
const PW_PLATFORMS = ['thunder','pikpak'];
let cloudCredentials = {};

async function loadCloudCredentials() {
  try {
    const res = await auth.authFetch('/admin/cloud-credentials');
    if (!res.ok) return;
    const data = await res.json();
    cloudCredentials = data.credentials || {};
    renderCloudCards();
    renderPlatformSelect();
  } catch {}
}

function renderCloudCards() {
  const grid = $('cloudLoginGrid');
  grid.innerHTML = '';
  const allPlatforms = [...QR_PLATFORMS, ...PW_PLATFORMS];

  for (const p of allPlatforms) {
    const cred = cloudCredentials[p];
    const isLoggedIn = cred && cred.hasCredential;
    const statusClass = isLoggedIn ? (cred.status === 'expired' ? 'expired' : 'valid') : 'none';
    const statusText = isLoggedIn ? (cred.status === 'expired' ? 'EXPIRED' : 'ACTIVE') : 'NOT SET';
    const isQR = QR_PLATFORMS.includes(p);
    const timeStr = cred?.obtainedAt ? new Date(cred.obtainedAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '';

    const card = document.createElement('div');
    card.className = 'cloud-card';
    card.innerHTML =
      '<div class="cloud-card-header">' +
        '<span class="cloud-card-name">' + (PLATFORM_NAMES[p]||p) + '</span>' +
        '<span class="cloud-badge ' + statusClass + '">' + statusText + '</span>' +
      '</div>' +
      (timeStr ? '<div class="cloud-card-time">' + timeStr + '</div>' : '') +
      '<div class="cloud-card-actions">' +
        (isQR ? '<button class="btn btn-sm" onclick="startQRLogin(\\''+p+'\\')">Scan QR</button>' :
                '<button class="btn btn-sm" onclick="showPasswordLogin(\\''+p+'\\')">Login</button>') +
        (isLoggedIn ? '<button class="btn btn-sm btn-danger" onclick="logoutPlatform(\\''+p+'\\')">Logout</button>' : '') +
      '</div>';
    grid.appendChild(card);
  }
}

function renderPlatformSelect() {
  const sel = $('manualPlatform');
  sel.innerHTML = '';
  for (const [k,v] of Object.entries(PLATFORM_NAMES)) {
    const opt = document.createElement('option');
    opt.value = k; opt.textContent = v;
    sel.appendChild(opt);
  }
}

let qrPollTimer = null;

async function startQRLogin(platform) {
  try {
    const res = await auth.authFetch('/admin/cloud-login/' + platform + '/qr', { method: 'POST' });
    if (!res.ok) { const e = await res.json(); toast(e.error || 'QR failed', 'error'); return; }
    const data = await res.json();
    showQRModal(platform, data.qrUrl, data.token);
  } catch (e) {
    toast('QR generate failed: ' + e.message, 'error');
  }
}

function showQRModal(platform, qrUrl, token) {
  closeQRModal();
  const overlay = document.createElement('div');
  overlay.className = 'qr-modal-overlay';
  overlay.id = 'qrModalOverlay';
  overlay.onclick = function(e) { if(e.target===overlay) closeQRModal(); };

  const qrImgUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=' + encodeURIComponent(qrUrl);

  overlay.innerHTML =
    '<div class="qr-modal">' +
    '<h3>' + (PLATFORM_NAMES[platform]||platform) + ' - Scan QR</h3>' +
    '<img src="' + qrImgUrl + '" alt="QR Code" onerror="this.alt=\\'QR: '+qrUrl.substring(0,60)+'...\\'">' +
    '<div class="qr-status" id="qrPollStatus">Waiting for scan...</div>' +
    '<div style="margin-top:14px;display:flex;gap:8px;justify-content:center">' +
    '<button class="btn btn-sm" onclick="closeQRModal()">Cancel</button>' +
    '</div></div>';

  document.body.appendChild(overlay);
  startQRPolling(platform, token);
}

function startQRPolling(platform, token) {
  if (qrPollTimer) clearInterval(qrPollTimer);
  let attempts = 0;
  const maxAttempts = 120; // 4 minutes at 2s intervals

  qrPollTimer = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) { closeQRModal(); toast('QR expired', 'error'); return; }

    try {
      const res = await auth.authFetch('/admin/cloud-login/' + platform + '/poll?token=' + encodeURIComponent(token));
      const data = await res.json();
      const statusEl = $('qrPollStatus');
      if (!statusEl) { clearInterval(qrPollTimer); return; }

      if (data.status === 'confirmed') {
        statusEl.className = 'qr-status confirmed';
        statusEl.textContent = 'Login successful!';
        clearInterval(qrPollTimer);
        setTimeout(() => { closeQRModal(); loadCloudCredentials(); toast(PLATFORM_NAMES[platform] + ' logged in', 'success'); }, 1000);
      } else if (data.status === 'scanned') {
        statusEl.className = 'qr-status scanned';
        statusEl.textContent = 'Scanned, waiting for confirmation...';
      } else if (data.status === 'expired') {
        statusEl.className = 'qr-status expired';
        statusEl.textContent = 'QR expired. Close and try again.';
        clearInterval(qrPollTimer);
      } else if (data.status === 'error') {
        statusEl.className = 'qr-status expired';
        statusEl.textContent = data.message || 'Error';
        clearInterval(qrPollTimer);
      }
    } catch {}
  }, 2000);
}

function closeQRModal() {
  if (qrPollTimer) { clearInterval(qrPollTimer); qrPollTimer = null; }
  const overlay = $('qrModalOverlay');
  if (overlay) overlay.remove();
}

async function showPasswordLogin(platform) {
  const username = prompt(PLATFORM_NAMES[platform] + ' - Username/Email:');
  if (!username) return;
  const password = prompt(PLATFORM_NAMES[platform] + ' - Password:');
  if (!password) return;

  try {
    const res = await auth.authFetch('/admin/cloud-login/' + platform + '/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (data.success) {
      toast(PLATFORM_NAMES[platform] + ' saved', 'success');
      loadCloudCredentials();
    } else {
      toast(data.message || 'Login failed', 'error');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function logoutPlatform(platform) {
  if (!confirm('Logout ' + (PLATFORM_NAMES[platform]||platform) + '?')) return;
  try {
    const res = await auth.authFetch('/admin/cloud-credentials/' + platform, { method: 'DELETE' });
    if (res.ok) {
      toast('Logged out', 'success');
      loadCloudCredentials();
    }
  } catch {}
}

async function manualPasteCredential() {
  const platform = $('manualPlatform').value;
  const rawValue = $('manualCredValue').value.trim();
  if (!rawValue) { toast('Please enter credential value', 'error'); return; }

  // 智能解析：尝试 JSON，否则按 cookie string 处理
  let credential;
  try {
    credential = JSON.parse(rawValue);
    if (typeof credential !== 'object') throw 0;
  } catch {
    // 账号密码平台
    if (PW_PLATFORMS.includes(platform) && rawValue.includes(':')) {
      const [u, ...rest] = rawValue.split(':');
      credential = { username: u, password: rest.join(':') };
    } else {
      credential = { cookie: rawValue };
    }
  }

  try {
    const res = await auth.authFetch('/admin/cloud-credentials/' + platform, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    if (res.ok) {
      $('manualCredValue').value = '';
      toast(PLATFORM_NAMES[platform] + ' saved', 'success');
      loadCloudCredentials();
    } else {
      const e = await res.json();
      toast(e.error || 'Save failed', 'error');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// --- Risk Report ---
async function loadRiskReport() {
  const container = $('riskReportContainer');
  const summary = $('riskSummary');

  try {
    const res = await auth.authFetch('/admin/credential-risk-report');
    if (!res.ok) { const e = await res.json(); toast(e.error || 'Failed', 'error'); return; }
    const data = await res.json();

    summary.textContent = 'Safe: ' + data.summary.safe + ' | Low: ' + data.summary.low +
      ' | High: ' + data.summary.high + ' | Unaudited: ' + data.summary.unaudited;

    const tbody = $('riskReportBody');
    tbody.innerHTML = '';

    // 只显示需要凭证的源（非 safe-A 类）
    const relevant = data.assessments.filter(a => a.neededPlatforms.length > 0 || a.riskLevel !== 'safe');
    const allowedSet = new Set(data.policy.allowedHighRiskKeys || []);
    const deniedSet = new Set(data.policy.deniedKeys || []);

    for (const a of relevant) {
      const tr = document.createElement('tr');
      const isAllowed = allowedSet.has(a.siteKey);
      const isDenied = deniedSet.has(a.siteKey);
      const needsAction = a.riskLevel === 'high' || a.riskLevel === 'unaudited';

      tr.innerHTML =
        '<td style="font-size:0.75rem">' + a.siteKey + '</td>' +
        '<td style="font-family:var(--mono);font-size:0.7rem">' + a.api + '</td>' +
        '<td><span class="risk-badge ' + a.riskLevel + '">' + a.riskLevel.toUpperCase() + '</span></td>' +
        '<td style="font-size:0.7rem">' + (a.neededPlatforms||[]).join(', ') + '</td>' +
        '<td style="font-size:0.7rem;color:' + (a.thirdPartyDomains.length ? 'var(--red)' : 'var(--text-dim)') + '">' +
          (a.thirdPartyDomains.join(', ') || '-') + '</td>' +
        '<td>' +
          (needsAction && !isAllowed ? '<button class="btn btn-sm" onclick="allowHighRisk(\\''+a.siteKey+'\\')">Allow</button>' : '') +
          (isAllowed ? '<button class="btn btn-sm btn-danger" onclick="revokeHighRisk(\\''+a.siteKey+'\\')">Revoke</button>' : '') +
          (isDenied ? '<span style="color:var(--red);font-size:0.7rem">DENIED</span>' : '') +
        '</td>';
      tbody.appendChild(tr);
    }

    container.style.display = 'block';
  } catch (e) {
    toast('Load failed: ' + e.message, 'error');
  }
}

async function allowHighRisk(siteKey) {
  if (!confirm('Allow credential injection for "' + siteKey + '"? Your cookies may be sent to third-party servers.')) return;
  try {
    const res = await auth.authFetch('/admin/credential-policy');
    const policy = await res.json();
    if (!policy.allowedHighRiskKeys) policy.allowedHighRiskKeys = [];
    if (!policy.allowedHighRiskKeys.includes(siteKey)) policy.allowedHighRiskKeys.push(siteKey);
    await auth.authFetch('/admin/credential-policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(policy),
    });
    loadRiskReport();
    toast('Allowed: ' + siteKey, 'success');
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function revokeHighRisk(siteKey) {
  try {
    const res = await auth.authFetch('/admin/credential-policy');
    const policy = await res.json();
    policy.allowedHighRiskKeys = (policy.allowedHighRiskKeys||[]).filter(k => k !== siteKey);
    await auth.authFetch('/admin/credential-policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(policy),
    });
    loadRiskReport();
    toast('Revoked: ' + siteKey, 'success');
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// ─── 去重配置 ──────────────────────────────────────────────
async function loadDedupConfig() {
  try {
    const res = await auth.authFetch('/admin/dedup-config');
    const cfg = await res.json();
    $('similarDedupCheck').checked = cfg.similarDedup !== false;
    const pct = Math.round((cfg.similarDedupThreshold || 0.85) * 100);
    $('dedupThreshold').value = pct;
    $('dedupThresholdVal').textContent = pct + '%';
  } catch {}
}
async function saveDedupConfig() {
  try {
    const cfg = {
      similarDedup: $('similarDedupCheck').checked,
      similarDedupThreshold: parseInt($('dedupThreshold').value) / 100,
    };
    const res = await auth.authFetch('/admin/dedup-config', {
      method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(cfg)
    });
    if (res.ok) { $('dedupStatus').textContent = '✓'; setTimeout(() => $('dedupStatus').textContent = '', 2000); }
  } catch {}
}

// ─── 分组排序 ──────────────────────────────────────────────
let groupRules = [];
async function loadGroupOrder() {
  try {
    const res = await auth.authFetch('/admin/group-order');
    const cfg = await res.json();
    $('groupOrderEnabled').checked = cfg.enabled;
    $('groupOrderUnmatched').value = cfg.unmatchedPosition || 'after';
    groupRules = cfg.rules || [];
    renderGroupRules();
  } catch {}
}
function renderGroupRules() {
  const container = $('groupOrderRules');
  if (groupRules.length === 0) { container.innerHTML = '<div style="color:var(--text-dim);font-size:0.85rem">No rules yet</div>'; return; }
  let html = '';
  groupRules.forEach((rule, i) => {
    html += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;padding:6px 8px;background:var(--surface-2);border-radius:4px">';
    html += '<span style="font-family:var(--mono);font-size:0.8rem;min-width:20px;color:var(--text-dim)">#' + (i+1) + '</span>';
    html += '<input type="text" value="' + esc(rule.name) + '" onchange="updateGroupRule(' + i + ',\\'name\\',this.value)" class="nt-input" style="width:80px" placeholder="Name">';
    html += '<input type="text" value="' + esc(rule.keywords.join(',')) + '" onchange="updateGroupRule(' + i + ',\\'keywords\\',this.value)" class="nt-input" style="flex:1" placeholder="Keywords (comma-separated)">';
    if (i > 0) html += '<button class="btn btn-sm" onclick="moveGroupRule(' + i + ',-1)">▲</button>';
    if (i < groupRules.length - 1) html += '<button class="btn btn-sm" onclick="moveGroupRule(' + i + ',1)">▼</button>';
    html += '<button class="btn btn-sm" style="color:var(--red)" onclick="removeGroupRule(' + i + ')">✕</button>';
    html += '</div>';
  });
  container.innerHTML = html;
}
function addGroupRule() {
  groupRules.push({ name: '', keywords: [] });
  renderGroupRules();
}
function removeGroupRule(i) { groupRules.splice(i, 1); renderGroupRules(); saveGroupOrder(); }
function moveGroupRule(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= groupRules.length) return;
  [groupRules[i], groupRules[j]] = [groupRules[j], groupRules[i]];
  renderGroupRules(); saveGroupOrder();
}
function updateGroupRule(i, field, value) {
  if (field === 'name') groupRules[i].name = value;
  else if (field === 'keywords') groupRules[i].keywords = value.split(',').map(s => s.trim()).filter(Boolean);
  saveGroupOrder();
}
async function saveGroupOrder() {
  try {
    const cfg = {
      enabled: $('groupOrderEnabled').checked,
      unmatchedPosition: $('groupOrderUnmatched').value,
      rules: groupRules,
    };
    const res = await auth.authFetch('/admin/group-order', {
      method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(cfg)
    });
    if (res.ok) { $('groupOrderStatus').textContent = '✓'; setTimeout(() => $('groupOrderStatus').textContent = '', 2000); }
  } catch {}
}

// ─── 背景设置 ──────────────────────────────────────────────
function onBgTypeChange() {
  const t = $('bgType').value;
  $('bgImageGroup').style.display = t === 'image' ? 'block' : 'none';
  $('bgSolidGroup').style.display = t === 'solid' ? 'block' : 'none';
  $('bgGradientGroup').style.display = t === 'gradient' ? 'block' : 'none';
}
async function loadBgSettings() {
  try {
    const res = await auth.authFetch('/admin/bg-settings');
    if (!res.ok) return;
    const cfg = await res.json();
    $('bgType').value = cfg.type || 'default';
    if (cfg.imageUrl) $('bgImageUrl').value = cfg.imageUrl;
    if (cfg.solidColor) $('bgSolidColor').value = cfg.solidColor;
    if (cfg.gradient) $('bgGradient').value = cfg.gradient;
    onBgTypeChange();
  } catch {}
}
async function saveBgSettings() {
  try {
    const cfg = {
      type: $('bgType').value,
      imageUrl: $('bgImageUrl').value,
      solidColor: $('bgSolidColor').value,
      gradient: $('bgGradient').value,
    };
    const res = await auth.authFetch('/admin/bg-settings', {
      method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(cfg)
    });
    if (res.ok) {
      $('bgStatus').textContent = '✓'; setTimeout(() => $('bgStatus').textContent = '', 2000);
      loadBgFromServer();
loadVersion();
    }
  } catch {}
}

// ─── 聚合日志 ──────────────────────────────────────────────
async function loadAggLogs() {
  try {
    const res = await auth.authFetch('/admin/agg-logs?limit=50');
    const data = await res.json();
    const logs = data.logs || [];
    if (logs.length === 0) {
      $('aggLogsList').innerHTML = '<div style="color:var(--text-dim)">No aggregation logs yet.</div>';
      return;
    }
    let html = '';
    logs.forEach(log => {
      const status = log.success ? '<span style="color:var(--green)">✓</span>' : '<span style="color:var(--red)">✕</span>';
      const time = new Date(log.startTime).toLocaleString();
      const dur = (log.durationMs / 1000).toFixed(1) + 's';
      html += '<div style="padding:8px;margin-bottom:6px;background:var(--surface-2);border-radius:4px;border-left:3px solid ' + (log.success ? 'var(--green)' : 'var(--red)') + '">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center">';
      html += '<span>' + status + ' ' + time + '</span>';
      html += '<span style="font-family:var(--mono);font-size:0.8rem;color:var(--text-dim)">' + dur + '</span>';
      html += '</div>';
      html += '<div style="font-size:0.8rem;color:var(--text-dim);margin-top:4px">';
      html += 'Sources: ' + log.okSources + '/' + log.totalSources + ' OK';
      html += ' &middot; Sites: ' + log.finalSiteCount + ' &middot; Parses: ' + log.finalParseCount + ' &middot; Lives: ' + log.finalLiveCount;
      html += '</div>';
      if (log.addedSites && log.addedSites.length > 0) {
        html += '<div style="font-size:0.8rem;color:var(--green);margin-top:2px">+ ' + log.addedSites.map(s => s.name || s.key).join(', ') + '</div>';
      }
      if (log.removedSites && log.removedSites.length > 0) {
        html += '<div style="font-size:0.8rem;color:var(--red);margin-top:2px">- ' + log.removedSites.map(s => s.name || s.key).join(', ') + '</div>';
      }
      if (log.failedSources && log.failedSources.length > 0) {
        html += '<div style="font-size:0.75rem;color:var(--amber);margin-top:2px">Failed: ' + log.failedSources.map(s => s.name).join(', ') + '</div>';
      }
      if (log.errorMessage) {
        html += '<div style="font-size:0.75rem;color:var(--red);margin-top:2px">Error: ' + esc(log.errorMessage) + '</div>';
      }
      html += '</div>';
    });
    $('aggLogsList').innerHTML = html;
  } catch {}
}
async function clearAggLogs() {
  if (!confirm('Clear all aggregation logs?')) return;
  await auth.authFetch('/admin/agg-logs', { method: 'DELETE' });
  loadAggLogs();
}

// ─── 调度执行历史 ──────────────────────────────────────
var RUN_STATUS_LABEL = { success: '成功', failed: '失败', timeout: '超时', running: '运行中', skipped: '跳过' };
var RUN_TRIGGER_LABEL = { cron: '定时', manual: '手动', startup: '启动', probe: '测速' };

function runColor(s) {
  if (s === 'success') return 'var(--green)';
  if (s === 'running') return 'var(--amber, #BA7517)';
  if (s === 'skipped') return 'var(--text-dim)';
  return 'var(--red)';
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '-';
  if (ms < 60000) return Math.round(ms / 1000) + 's';
  return Math.floor(ms / 60000) + 'm' + Math.round((ms % 60000) / 1000) + 's';
}

function fmtLocal(iso) {
  if (!iso) return '-';
  var d = new Date(iso);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

async function loadRunHistory() {
  try {
    var res = await auth.authFetch('/admin/run-history?limit=40');
    var data = await res.json();
    renderRunSummary(data.summary);
    renderRunDaily(data.summary.daily || []);
    var runs = data.runs || [];
    if (runs.length === 0) {
      $('runTable').innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem">还没有执行记录（下次聚合开始后出现）。</div>';
      return;
    }
    var html = '<table style="width:100%;border-collapse:collapse;font-size:0.78rem">';
    html += '<tr style="text-align:left;color:var(--text-dim);border-bottom:1px solid var(--border)">';
    html += '<th style="padding:6px">开始</th><th>类型</th><th>触发</th><th>状态</th><th>耗时</th><th>产出 / 说明</th></tr>';
    runs.forEach(function(r) {
      var detail = '';
      if (r.stats && r.stats.channels != null) {
        detail = r.stats.channels + ' 频道 / ' + r.stats.urls + ' 源';
      }
      if (r.error) detail += (detail ? ' · ' : '') + esc(r.error);
      if (!detail && r.note) detail = esc(r.note);
      html += '<tr style="border-bottom:1px solid var(--border)">';
      html += '<td style="padding:6px;font-family:var(--mono)">' + fmtLocal(r.startedAt) + '</td>';
      html += '<td>' + (r.kind === 'aggregate' ? '聚合' : r.kind === 'probe' ? '测速' : r.kind === 'guard' ? '守夜' : '备份') + '</td>';
      html += '<td>' + (RUN_TRIGGER_LABEL[r.trigger] || r.trigger) + '</td>';
      html += '<td style="color:' + runColor(r.status) + ';font-weight:600">' + (RUN_STATUS_LABEL[r.status] || r.status) + '</td>';
      html += '<td style="font-family:var(--mono)">' + fmtDuration(r.durationMs) + '</td>';
      html += '<td style="color:var(--text-dim)">' + detail + '</td>';
      html += '</tr>';
    });
    html += '</table>';
    $('runTable').innerHTML = html;
  } catch (e) {
    $('runTable').innerHTML = '<div style="color:var(--red);font-size:0.8rem">读取执行历史失败</div>';
  }
}

function renderRunSummary(s) {
  if (!s) { $('runSummary').innerHTML = ''; return; }
  var ok = s.lastSuccess ? fmtLocal(s.lastSuccess.startedAt) : '无';
  var color = s.stale ? 'var(--red)' : 'var(--green)';
  var html = '';
  html += '<span>最近成功：<b style="color:' + color + '">' + ok + '</b></span>';
  html += '<span>连续失败：<b style="color:' + (s.consecutiveFailures > 0 ? 'var(--red)' : 'var(--text-secondary)') + '">' + s.consecutiveFailures + '</b></span>';
  html += '<span>今天：' + s.today.success + ' 成功 / ' + s.today.failed + ' 失败' + (s.today.running ? ' / ' + s.today.running + ' 运行中' : '') + '</span>';
  if (s.stale) {
    html += '<span style="color:var(--red);font-weight:600">⚠ 已 ' + (s.staleHours >= 0 ? s.staleHours + ' 小时' : '很久') + '没有成功聚合</span>';
  } else {
    html += '<span style="color:var(--green)">调度正常</span>';
  }
  $('runSummary').innerHTML = html;
}

function renderRunDaily(daily) {
  if (!daily || daily.length === 0) { $('runDaily').innerHTML = ''; return; }
  var html = '';
  daily.forEach(function(d) {
    var label = d.date.slice(5);
    var mark = d.status === 'success' ? '✓' : d.status === 'failed' ? '✕' : d.status === 'partial' ? '…' : '·';
    var color = d.status === 'success' ? 'var(--green)' : d.status === 'failed' ? 'var(--red)' : 'var(--text-dim)';
    var bg = d.status === 'success' ? 'rgba(29,158,117,0.12)' : d.status === 'failed' ? 'rgba(220,50,47,0.12)' : 'var(--surface-2)';
    html += '<span style="padding:3px 8px;border-radius:6px;background:' + bg + ';color:' + color + ';font-family:var(--mono)">'
      + label + ' ' + mark + (d.at ? ' ' + d.at : '') + '</span>';
  });
  $('runDaily').innerHTML = html;
}

// ─── 告警配置 ──────────────────────────────────────────
async function loadAlertConfig() {
  try {
    var res = await auth.authFetch('/admin/alert-config');
    var cfg = await res.json();
    $('alertEnabled').checked = !!cfg.enabled;
    $('alertWebhook').value = cfg.webhookUrl || '';
    $('alertTgToken').value = cfg.telegramToken || '';
    $('alertTgChat').value = cfg.telegramChatId || '';
    $('alertOnSuccess').checked = !!cfg.onSuccess;
  } catch (e) {}
}

async function saveAlertConfig() {
  var body = {
    enabled: $('alertEnabled').checked,
    webhookUrl: $('alertWebhook').value.trim(),
    telegramToken: $('alertTgToken').value.trim(),
    telegramChatId: $('alertTgChat').value.trim(),
    onSuccess: $('alertOnSuccess').checked
  };
  try {
    var res = await auth.authFetch('/admin/alert-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var d = await res.json();
    $('alertStatus').textContent = d.success ? '已保存' : '保存失败';
    $('alertStatus').style.color = d.success ? 'var(--green)' : 'var(--red)';
    setTimeout(function() { $('alertStatus').textContent = ''; }, 2500);
  } catch (e) {
    $('alertStatus').textContent = '保存失败';
  }
}

async function testAlert() {
  $('alertStatus').textContent = '发送中…';
  try {
    var res = await auth.authFetch('/admin/alert-config/test', { method: 'POST' });
    var d = await res.json();
    if (d.success) {
      $('alertStatus').textContent = '已发送';
      $('alertStatus').style.color = 'var(--green)';
    } else {
      var why = d.delivery && d.delivery.skipped ? d.delivery.skipped : (d.delivery ? (d.delivery.webhook || d.delivery.telegram || '失败') : '失败');
      $('alertStatus').textContent = '未发送：' + why;
      $('alertStatus').style.color = 'var(--red)';
    }
  } catch (e) {
    $('alertStatus').textContent = '发送失败';
    $('alertStatus').style.color = 'var(--red)';
  }
}

// ─── 源质量保障 ────────────────────────────────────────
var TIER_NAME = { cctv: '央视', satellite: '卫视', local: '地方台', other: '其他' };

async function loadQuality() {
  try {
    var res = await auth.authFetch('/admin/quality-gap');
    var d = await res.json();
    $('qualityEnabled').checked = d.enabled !== false;
    $('guardEnabled').checked = d.guardEnabled !== false;
    renderGuardReport(d.guard);
    var report = d.report;
    if (!report) {
      $('qualitySummary').innerHTML = '<span style="color:var(--text-dim)">还没有质量报告（跑一次聚合后生成）。</span>';
      $('qualityGaps').innerHTML = '';
      return;
    }
    var st = report.stats || {};
    var cov = report.coverage || [];
    var html = '';
    cov.forEach(function(c) {
      if (!c.channels) return;
      var color = c.met === c.channels ? 'var(--green)' : (c.met >= c.channels * 0.7 ? 'var(--amber, #BA7517)' : 'var(--red)');
      html += '<span>' + (TIER_NAME[c.tier] || c.tier) + '：<b style="color:' + color + '">' + c.met + '/' + c.channels + '</b> 达标</span>';
    });
    html += '<span>补测：<b>' + (st.probed || 0) + '</b> 条</span>';
    html += '<span>缺口：<b style="color:' + ((st.gapAfter || 0) > 0 ? 'var(--red)' : 'var(--green)') + '">' + (st.gapAfter || 0) + '</b> 条</span>';
    html += '<span style="color:var(--text-dim)">' + (report.at ? fmtLocal(report.at) + ' 生成' : '') + '</span>';
    $('qualitySummary').innerHTML = html;

    var gaps = report.gaps || [];
    if (gaps.length === 0) {
      $('qualityGaps').innerHTML = '<div style="color:var(--green);font-size:0.8rem">所有重点频道都达到保底条数。</div>';
      return;
    }
    var t = '<table style="width:100%;border-collapse:collapse;font-size:0.78rem">';
    t += '<tr style="text-align:left;color:var(--text-dim);border-bottom:1px solid var(--border)"><th style="padding:6px">档位</th><th>频道</th><th>可播/保底</th><th>源池</th><th>不同域名</th></tr>';
    gaps.forEach(function(g) {
      t += '<tr style="border-bottom:1px solid var(--border)">';
      t += '<td style="padding:6px">' + (TIER_NAME[g.tier] || g.tier) + '</td>';
      t += '<td>' + esc(g.name) + '</td>';
      t += '<td style="color:' + (g.verified === 0 ? 'var(--red)' : 'var(--amber, #BA7517)') + ';font-weight:600">' + g.verified + '/' + g.quota + '</td>';
      t += '<td>' + g.pool + '</td>';
      t += '<td>' + g.hosts + '</td>';
      t += '</tr>';
    });
    t += '</table>';
    $('qualityGaps').innerHTML = t;
  } catch (e) {}
}

function renderGuardReport(g) {
  if (!g) {
    $('guardReport').textContent = '守夜还未运行过（每小时 :20 自动跑，也可点「立即自检」）。';
    return;
  }
  var t = g.state === 'done' ? '有修复' : g.state === 'partial' ? '预算用完' : g.state === 'skipped' ? '已跳过' : '无变化';
  var line = '最近守夜 ' + fmtLocal(g.at) + ' · ' + t
    + ' · 检查 ' + (g.checked || 0) + ' 台'
    + ' · 补测 ' + (g.probed || 0) + ' 条'
    + ' · 修复 ' + (g.repaired || 0) + ' 台'
    + ' · 新源 ' + (g.addedUrls || 0) + ' 条'
    + ' · 缺口 ' + ((g.gaps && g.gaps.length) || 0)
    + (g.published ? ' · 已重新发布' : '');
  $('guardReport').textContent = line;
}

async function saveGuardToggle() {
  var enabled = $('guardEnabled').checked;
  try {
    await auth.authFetch('/admin/quality-guard', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enabled }) });
    $('guardStatus').textContent = enabled ? '已开启' : '已关闭';
    setTimeout(function() { $('guardStatus').textContent = ''; }, 2000);
  } catch (e) {
    $('guardStatus').textContent = '保存失败';
  }
}

async function runGuardNow() {
  $('guardStatus').textContent = '守夜运行中…';
  try {
    var res = await auth.authFetch('/admin/quality-guard/run', { method: 'POST' });
    var d = await res.json();
    if (d.success) {
      $('guardStatus').textContent = '完成';
      loadQuality();
    } else {
      $('guardStatus').textContent = d.error || '失败';
    }
  } catch (e) {
    $('guardStatus').textContent = '失败';
  }
  setTimeout(function() { $('guardStatus').textContent = ''; }, 3000);
}

async function saveQualityToggle() {
  var enabled = $('qualityEnabled').checked;
  try {
    await auth.authFetch('/admin/quality-guarantee', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enabled }) });
    $('qualityStatus').textContent = enabled ? '已开启，下次聚合生效' : '已关闭';
    setTimeout(function() { $('qualityStatus').textContent = ''; }, 2500);
  } catch (e) {
    $('qualityStatus').textContent = '保存失败';
  }
}

// ─── 编排规则 ──────────────────────────────────────────
async function loadCurationRules() {
  try {
    var res = await auth.authFetch('/admin/curation-rules');
    var d = await res.json();
    fillCurationRules(d.rules);
  } catch (e) {}
}

function fillCurationRules(r) {
  if (!r) return;
  $('ruleCctv').value = (r.cctvOrder || []).join('\\n');
  $('ruleSat').value = (r.satOrder || []).join('\\n');
  $('ruleNj').value = (r.nanjingOrder || []).join('\\n');
  $('ruleProvince').value = (r.provinceOrder || []).join('\\n');
  $('excludePaid').checked = r.excludePaid !== false;
  $('excludeOverseas').checked = r.excludeOverseas !== false;
  $('rulePaid').value = (r.paidChannels || []).join('\\n');
  $('ruleNiche').value = (r.nicheKeywords || []).join('\\n');
  $('ruleOverseasGroups').value = (r.overseasGroups || []).join('\\n');
  $('ruleOverseasKeywords').value = (r.overseasKeywords || []).join('\\n');
  $('ruleKeep').value = (r.keepChannels || []).join('\\n');
  $('ruleFocusSources').value = r.focusSources || 8;
  var q = r.quotas || {};
  $('quotaCctv').value = q.cctv == null ? 6 : q.cctv;
  $('quotaSatellite').value = q.satellite == null ? 5 : q.satellite;
  $('quotaLocal').value = q.local == null ? 2 : q.local;
}

function readLines(id) {
  return $(id).value.split('\\n').map(function(x) { return x.trim(); }).filter(Boolean);
}

async function saveCurationRules() {
  var body = {
    cctvOrder: readLines('ruleCctv'),
    satOrder: readLines('ruleSat'),
    nanjingOrder: readLines('ruleNj'),
    provinceOrder: readLines('ruleProvince'),
    focusSources: Number($('ruleFocusSources').value) || 8,
    quotas: {
      cctv: Number($('quotaCctv').value) || 0,
      satellite: Number($('quotaSatellite').value) || 0,
      local: Number($('quotaLocal').value) || 0
    },
    excludePaid: $('excludePaid').checked,
    excludeOverseas: $('excludeOverseas').checked,
    paidChannels: readLines('rulePaid'),
    nicheKeywords: readLines('ruleNiche'),
    overseasGroups: readLines('ruleOverseasGroups'),
    overseasKeywords: readLines('ruleOverseasKeywords'),
    keepChannels: readLines('ruleKeep')
  };
  try {
    var res = await auth.authFetch('/admin/curation-rules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var d = await res.json();
    if (d.success) {
      fillCurationRules(d.rules);
      $('curationStatus').textContent = '已保存，下次聚合生效';
      $('curationStatus').style.color = 'var(--green)';
    } else {
      $('curationStatus').textContent = '保存失败';
      $('curationStatus').style.color = 'var(--red)';
    }
    setTimeout(function() { $('curationStatus').textContent = ''; }, 3500);
  } catch (e) {
    $('curationStatus').textContent = '保存失败';
    $('curationStatus').style.color = 'var(--red)';
  }
}

async function resetCurationRules() {
  if (!confirm('恢复默认编排规则？')) return;
  try {
    var res = await auth.authFetch('/admin/curation-rules', { method: 'DELETE' });
    var d = await res.json();
    fillCurationRules(d.rules);
    $('curationStatus').textContent = '已恢复默认';
    $('curationStatus').style.color = 'var(--green)';
    setTimeout(function() { $('curationStatus').textContent = ''; }, 3000);
  } catch (e) {}
}

// ─── 直播禁用 ──────────────
async function loadLiveDisabled() {
  try {
    const r = await auth.authFetch('/admin/live-disabled');
    const d = await r.json();
    $('liveDisabledCheck').checked = d.disabled;
  } catch {}
}
async function saveLiveDisabled() {
  const disabled = $('liveDisabledCheck').checked;
  await auth.authFetch('/admin/live-disabled', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({disabled}) });
  $('liveDisabledStatus').textContent = '✓';
  setTimeout(() => $('liveDisabledStatus').textContent = '', 2000);
}

// ─── 直播合并模式 ──────────
async function loadLiveMergeMode() {
  try {
    const r = await auth.authFetch('/admin/live-merge-mode');
    const d = await r.json();
    const mode = d.mode || 'separated';
    $('liveMergeSeparated').classList.toggle('active', mode === 'separated');
    $('liveMergeMerged').classList.toggle('active', mode === 'merged');
  } catch {}
}
async function setLiveMergeMode(mode) {
  $('liveMergeSeparated').classList.toggle('active', mode === 'separated');
  $('liveMergeMerged').classList.toggle('active', mode === 'merged');
  $('liveMergeModeStatus').textContent = '⏳';
  try {
    await auth.authFetch('/admin/live-merge-mode', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({mode}) });
    $('liveMergeModeStatus').textContent = '✓ 已切换并刷新';
    setTimeout(() => $('liveMergeModeStatus').textContent = '', 3000);
  } catch(e) {
    $('liveMergeModeStatus').textContent = '✗ 失败';
  }
}

// ─── 智能 Base URL ──────────
async function loadSmartBaseUrl() {
  try {
    const r = await auth.authFetch('/admin/smart-base-url');
    const d = await r.json();
    $('smartBaseUrlCheck').checked = d.enabled;
  } catch {}
}
async function saveSmartBaseUrl() {
  const enabled = $('smartBaseUrlCheck').checked;
  await auth.authFetch('/admin/smart-base-url', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({enabled}) });
  $('smartBaseUrlStatus').textContent = '✓';
  setTimeout(() => $('smartBaseUrlStatus').textContent = '', 2000);
}

// ─── 验活深度 ────────────────
async function loadProbeDepth() {
  try {
    const r = await auth.authFetch('/admin/site-probe-depth');
    const d = await r.json();
    $('probeDepthSelect').value = d.depth || 'deep';
  } catch {}
}
async function saveProbeDepth() {
  const depth = $('probeDepthSelect').value;
  await auth.authFetch('/admin/site-probe-depth', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({depth}) });
  $('probeDepthStatus').textContent = '✓';
  setTimeout(() => $('probeDepthStatus').textContent = '', 2000);
}

// ─── 自动清理 ────────────────
async function loadAutoClean() {
  try {
    const r = await auth.authFetch('/admin/site-auto-clean');
    const d = await r.json();
    $('autoCleanCheck').checked = d.enabled;
  } catch {}
}
async function saveAutoClean() {
  const enabled = $('autoCleanCheck').checked;
  await auth.authFetch('/admin/site-auto-clean', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({enabled}) });
  $('autoCleanStatus').textContent = '✓';
  setTimeout(() => $('autoCleanStatus').textContent = '', 2000);
}

// ─── Init new settings ───────
loadLiveDisabled();
loadLiveMergeMode();
loadLiveGroups();
loadShoppingFilter();
loadUseConfigLives();
loadProbeInline();
loadProbeSegment();
loadChannelOrder();
loadSmartBaseUrl();
loadProbeDepth();
loadAutoClean();
loadKeepLink();
loadFtpSync();

applyTheme(getTheme());
initThemeDropdown();
loadBgFromServer();
loadVersion();
applyLang(translations, getLang());
</script>
</body>
</html>`;
