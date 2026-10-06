/**
 * 模块 5：/geometry 台阵几何视图与结构版本查看、JSON 导入导出
 * 由台站经纬度实算孔径与台站间距，绘制几何平面图；
 * 复用 <EmptyPanel>、<StatBadge>。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Input,
  Radio,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import {
  CheckCircleOutlined,
  DownloadOutlined,
  ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import type { UploadFile } from 'antd';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { applyNetworkReconcile, selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import { selectCalibrations, selectReplaces } from '@/stores/calibrationSlice';
import {
  db,
  DB_NAME,
  DB_VERSION,
  countAll,
  initDatabase,
  readLastBackupAt,
  readStampedDbVersion,
  resetDatabase,
  type BackupPayload,
} from '@/utils/db';
import {
  buildArraySummaries,
  buildBackupPayload,
  countPayload,
  exportBackupJson,
  importBackup,
  readFileText,
  remapIds,
  stationRadialDistances,
  validateBackup,
  type CountMap,
} from '@/utils/export';
import {
  reconcileStations,
  type NetworkStationRecord,
  type ReconcileResult,
  type StationReconcileItem,
} from '@/utils/reconcile';
import { bearingDeg, round, stationDistances, toLocalPlane, planeViewBox } from '@/utils/geo';

const EMPTY_COUNTS: CountMap = { arrays: 0, stations: 0, instruments: 0, calibrations: 0, replaces: 0 };

export default function GeometryView() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();

  const arrays = useAppSelector(selectArrays);
  const stations = useAppSelector(selectStations);
  const instruments = useAppSelector(selectInstruments);
  const calibrations = useAppSelector(selectCalibrations);
  const replaces = useAppSelector(selectReplaces);

  const [selectedArrayId, setSelectedArrayId] = useState<string | null>(null);
  const [counts, setCounts] = useState<CountMap>(EMPTY_COUNTS);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [stampedVersion, setStampedVersion] = useState<number>(DB_VERSION);
  const [overwriteOnImport, setOverwriteOnImport] = useState(true);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  // 两侧对账：networkText 为台网中心侧台站投运台账 JSON 文本；对账失败只重试布设班组侧
  const [networkText, setNetworkText] = useState<string>('');
  const [networkRecords, setNetworkRecords] = useState<NetworkStationRecord[]>([]);
  const [reconcileResult, setReconcileResult] = useState<ReconcileResult | null>(null);

  useEffect(() => {
    if (arrays.length === 0) void initDatabase();
    setSelectedArrayId((current) => current ?? arrays[0]?.id ?? null);
  }, [arrays]);

  const refresh = async (): Promise<void> => {
    setCounts((await countAll()) as CountMap);
    setLastBackupAt(readLastBackupAt());
    setStampedVersion(readStampedDbVersion());
  };

  useEffect(() => {
    void refresh();
    // 数据变化后刷新统计
  }, [arrays, stations, instruments, calibrations, replaces]);

  const activeArrayId = selectedArrayId ?? arrays[0]?.id ?? null;
  const activeArray = arrays.find((row) => row.id === activeArrayId) ?? null;
  const activeStations = useMemo(
    () => stations.filter((station) => station.arrayId === activeArrayId),
    [activeArrayId, stations]
  );

  /** 台阵几何与标定结论汇总 */
  const summaries = useMemo(() => {
    const payload: BackupPayload = {
      app: 'gbseisarray',
      dbVersion: DB_VERSION,
      exportedAt: new Date().toISOString(),
      arrays,
      stations,
      instruments,
      calibrations,
      replaces,
    };
    return buildArraySummaries(payload);
  }, [arrays, calibrations, instruments, replaces, stations]);

  const activeSummary = summaries.find((row) => row.arrayId === activeArrayId) ?? null;

  /** 几何平面坐标（以台阵中心为原点，单位 km） */
  const plane = useMemo(() => {
    if (!activeSummary?.center) return [];
    return toLocalPlane(
      activeStations.map((station) => ({
        id: station.id,
        code: station.code,
        lat: station.lat,
        lng: station.lng,
      })),
      activeSummary.center
    );
  }, [activeStations, activeSummary]);

  const viewBox = useMemo(() => planeViewBox(plane), [plane]);

  /** SVG 视口（保持宽高比，长边 460） */
  const svg = useMemo(() => {
    const scale = 460 / Math.max(viewBox.width, viewBox.height, 1);
    const width = viewBox.width * scale;
    const height = viewBox.height * scale;
    const toSvgX = (x: number): number => (x - viewBox.minX) * scale;
    const toSvgY = (y: number): number => height - (y - viewBox.minY) * scale;
    const points = plane.map((point) => ({ ...point, sx: toSvgX(point.x), sy: toSvgY(point.y) }));
    // 台站间距连线（取最远的三条，突出孔径）
    const distances = stationDistances(plane);
    const lines = distances.slice(0, 3).map((row) => {
      const from = points.find((point) => point.id === row.from);
      const to = points.find((point) => point.id === row.to);
      return from && to ? { ...row, x1: from.sx, y1: from.sy, x2: to.sx, y2: to.sy } : null;
    });
    return { width: Math.max(width, 80), height: Math.max(height, 80), points, lines: lines.filter(Boolean) as Array<{ from: string; to: string; fromCode: string; toCode: string; km: number; x1: number; y1: number; x2: number; y2: number }> };
  }, [plane, viewBox]);

  const radial = useMemo(
    () =>
      stationRadialDistances(
        activeStations.map((station) => ({
          id: station.id,
          code: station.code,
          lat: station.lat,
          lng: station.lng,
        })),
        activeSummary?.center ?? null
      ),
    [activeStations, activeSummary]
  );

  /* --------------------- 两侧对账（布设班组 ↔ 台网中心） --------------------- */

  /** 台网中心侧示例台账：包含一条对不上的台站码，便于演示单列 */
  const buildDemoNetworkRoster = (): string =>
    JSON.stringify(
      [
        { code: 'LTX01', arrayState: '运行中' },
        { code: 'LTX02', arrayState: '运行中' },
        { code: 'LTX03', arrayState: '运行中' },
        { code: 'HX01', arrayState: '运行中' },
        { code: 'HX02', arrayState: '运行中' },
        { code: 'YWS01', arrayState: '建设中' },
        { code: 'YWS02', arrayState: '建设中' },
        // 台网中心有、布设班组侧无此台站码——对不上时单列，不阻塞其余对账
        { code: 'YWS03', arrayState: '建设中', commissionDate: '' },
      ],
      null,
      2
    );

  const parseNetworkRoster = (text: string): NetworkStationRecord[] | { error: string } => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { error: '台网中心台账不是合法 JSON' };
    }
    if (!Array.isArray(parsed)) return { error: '台账应为台站记录数组（[{ code, arrayState, commissionDate }]）' };
    const records: NetworkStationRecord[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null || typeof (item as { code?: unknown }).code !== 'string') {
        return { error: '每条记录必须包含字符串类型的 code（台站码）' };
      }
      const row = item as { code: string; arrayState?: unknown; commissionDate?: unknown };
      records.push({
        code: row.code,
        arrayState:
          row.arrayState === '建设中' || row.arrayState === '运行中' || row.arrayState === '停测'
            ? row.arrayState
            : undefined,
        commissionDate: typeof row.commissionDate === 'string' ? row.commissionDate : undefined,
        raw: row,
      });
    }
    return records;
  };

  /** 对账（读取两侧当前数据；台网中心侧记录已由使用者导入，不回退） */
  const runReconcile = useCallback(
    (records: NetworkStationRecord[]) => {
      const result = reconcileStations(arrays, stations, records);
      setReconcileResult(result);
      return result;
    },
    [arrays, stations]
  );

  const handleReconcile = () => {
    if (!networkText.trim()) {
      message.warning('请先粘贴台网中心侧台站投运台账 JSON');
      return;
    }
    const parsed = parseNetworkRoster(networkText);
    if ('error' in parsed) {
      message.error(parsed.error);
      return;
    }
    setNetworkRecords(parsed);
    const result = runReconcile(parsed);
    message.success(
      `对账完成：匹配 ${result.matched.length} 个，异常 ${result.exceptions.length} 个，仅本库 ${result.localOnly.length} 个，仅台网中心 ${result.networkOnly.length} 个`
    );
  };

  /**
   * 对账失败只重试布设班组侧：重新读取本库台站 / 台阵再对账，
   * 台网中心导入的投运台账与已核定的投运日期一律不回退。
   */
  const handleRetryLocal = async () => {
    if (networkRecords.length === 0) {
      message.warning('尚无台网中心侧台账，请先粘贴并完成一次对账');
      return;
    }
    const [freshArrays, freshStations] = await Promise.all([
      db.arrays.toArray(),
      db.stations.toArray(),
    ]);
    const result = reconcileStations(freshArrays, freshStations, networkRecords);
    setReconcileResult(result);
    message.success(
      `已仅按布设班组侧重试：匹配 ${result.matched.length}，仅本库 ${result.localOnly.length}，仅台网中心 ${result.networkOnly.length}`
    );
  };

  /** 采用台网中心核定：把运行状态与合法投运日期落到台阵档案（投运日不回退） */
  const handleApplyNetwork = async () => {
    if (networkRecords.length === 0) {
      message.warning('请先粘贴台网中心侧台账');
      return;
    }
    const confirmed = window.confirm(
      '将按台站码采用台网中心核定的台阵状态与投运日期；投运日期一旦核定不回退。确认继续？'
    );
    if (!confirmed) return;
    const result = await dispatch(applyNetworkReconcile({ records: networkRecords })).unwrap();
    message.success(`已采用台网中心核定：影响 ${result.applied} 个台站、${result.arrayCount} 个台阵`);
    runReconcile(networkRecords);
  };

  const reconcileColumns = [
    { title: '台站码', dataIndex: 'key', width: 110, className: 'gb-mono' },
    {
      title: '本库台阵 / 状态',
      width: 200,
      render: (_: unknown, item: StationReconcileItem) =>
        item.array ? (
          <span>
            {item.array.name}
            <Tag style={{ marginInlineStart: 4 }}>{item.array.state}</Tag>
          </span>
        ) : (
          <span className="gb-hint">—</span>
        ),
    },
    {
      title: '台网中心状态 / 投运日',
      width: 210,
      render: (_: unknown, item: StationReconcileItem) =>
        item.network ? (
          <span className="gb-mono">
            {item.network.arrayState ?? '（未给状态）'}
            {' / '}
            {item.commissionDate ?? (item.network.commissionDate ? <Tag color="red">日期非法</Tag> : '—')}
          </span>
        ) : (
          <span className="gb-hint">台网中心无此台站</span>
        ),
    },
    {
      title: '结果',
      render: (_: unknown, item: StationReconcileItem) => {
        if (item.issue === '') return <Tag color="green">两侧匹配</Tag>;
        if (item.issue === 'missing-network') return <Tag color="orange">仅本库有，待台网中心补录</Tag>;
        if (item.issue === 'missing-local') return <Tag color="red">仅台网中心有，待布设班组核对</Tag>;
        if (item.issue === 'state-mismatch') return <Tag color="red">两侧状态不一致</Tag>;
        return <Tag color="red">投运日期非法，保留原值待核</Tag>;
      },
    },
  ];

  const handleExport = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await exportBackupJson();
      await refresh();
      setNotice(
        `已导出 ${result.fileName}（共 ${Object.values(result.counts).reduce((sum, value) => sum + value, 0)} 条记录）`
      );
      message.success(`已导出 ${result.fileName}`);
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async (): Promise<void> => {
    const file = fileList[0]?.originFileObj ?? (fileList[0] as unknown as File | undefined);
    if (!file) {
      message.warning('请先选择备份 JSON 文件');
      return;
    }
    setBusy(true);
    try {
      const text = await readFileText(file as File);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        message.error('文件不是合法的 JSON，无法解析');
        return;
      }
      const validation = validateBackup(parsed);
      if (!validation.ok || !validation.payload) {
        message.error(`备份校验失败：${validation.errors.join('；')}`);
        return;
      }
      const payload = overwriteOnImport ? validation.payload : remapIds(validation.payload);
      const summary = countPayload(payload);
      const confirmed = window.confirm(
        `将导入 ${Object.entries(summary)
          .map(([key, value]) => `${key} ${value} 条`)
          .join('、')}；${overwriteOnImport ? '覆盖模式会先清空现有本地数据' : '追加模式会重新分配 id 保留现有数据'}。确认继续？`
      );
      if (!confirmed) return;
      await importBackup(payload, overwriteOnImport);
      await refresh();
      setNotice('导入完成，几何视图与统计已刷新。');
      message.success('导入完成');
    } finally {
      setBusy(false);
      setFileList([]);
    }
  };

  const handleReset = async (): Promise<void> => {
    const confirmed = window.confirm(
      '将清空全部本地数据并重新播种演示数据（台阵、台站、仪器、标定、更换）。确认继续？'
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await resetDatabase();
      await refresh();
      setNotice('本地数据已重置为演示数据。');
      message.success('本地数据已重置');
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async (): Promise<void> => {
    const text = summaries
      .map(
        (row) =>
          `${row.arrayName}（${row.state} / ${row.department}）：布设 ${row.deployDate}，投运 ${
            row.state === '建设中' ? '未投运' : row.commissionDate || '待核定'
          }，台站 ${row.stationCount} 个，仪器 ${row.instrumentCount} 台（在账 ${row.ledgerCount} 台），实算孔径 ${row.computedApertureKm} km，平均台间距 ${row.meanSpacingKm} km，累计标定 ${row.calibrationCount} 次，不合格 ${row.unqualifiedCount} 次，超期 ${row.overdueCount} 台，按期标定率 ${row.onScheduleRate}%，投运日待核 ${row.unresolvedCount} 台，未闭环更换 ${row.pendingReplaceCount} 条。`
      )
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setNotice('台阵几何与标定结论已复制到剪贴板。');
      message.success('已复制结论');
    } catch {
      message.warning('当前浏览器不允许读取剪贴板，请手动选中表格内容复制');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            台阵几何视图与结构版本
          </Typography.Title>
          <p className="gb-hint">
            按台站经纬度实算孔径与台站间距并绘制几何平面图；同时可查看 IndexedDB 结构版本并导入导出全量 JSON。
          </p>
        </div>
        <Space wrap>
          <Select
            style={{ width: 220 }}
            value={activeArrayId ?? undefined}
            placeholder="选择台阵"
            onChange={(value) => setSelectedArrayId(value)}
            options={arrays.map((row) => ({ label: row.name, value: row.id }))}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void refresh()}>
            刷新
          </Button>
          <Button onClick={() => void handleCopy()}>复制结论</Button>
          <Button type="primary" icon={<DownloadOutlined />} loading={busy} onClick={() => void handleExport()}>
            导出 JSON
          </Button>
        </Space>
      </div>

      {notice ? <Alert type="success" showIcon message={notice} closable onClose={() => setNotice('')} /> : null}

      <div className="gb-stats-row">
        <StatBadge label="台阵" value={counts.arrays} suffix="个" tone="primary" />
        <StatBadge label="台站" value={counts.stations} suffix="个" tone="info" />
        <StatBadge label="仪器" value={counts.instruments} suffix="台" tone="default" />
        <StatBadge label="标定记录" value={counts.calibrations} suffix="次" tone="success" />
        <StatBadge label="更换记录" value={counts.replaces} suffix="条" tone="warning" />
      </div>

      {!activeArray || !activeSummary ? (
        <EmptyPanel
          title="还没有台阵"
          description="先到「台阵与台站台账」新建台阵并录入台站经纬度，即可查看几何视图。"
          actionText="去新建台阵"
          onAction={() => void initDatabase()}
        />
      ) : (
        <Row gutter={[14, 14]}>
          <Col xs={24} xl={14}>
            <Card
              className="gb-panel"
              size="small"
              title={`${activeArray.name} · 台站几何平面图`}
              extra={<span className="gb-hint">单位为 km，以北为正方向</span>}
            >
              {svg.points.length === 0 ? (
                <EmptyPanel title="该台阵还没有台站" description="在台站仪器页新增台站后即可绘制几何视图。" compact />
              ) : (
                <>
                  <svg
                    viewBox={`0 0 ${svg.width} ${svg.height}`}
                    style={{ width: '100%', height: 320, background: '#f7fafc', borderRadius: 10 }}
                  >
                    <line x1="0" y1={svg.height / 2} x2={svg.width} y2={svg.height / 2} stroke="#e3eaf3" />
                    <line x1={svg.width / 2} y1="0" x2={svg.width / 2} y2={svg.height} stroke="#e3eaf3" />
                    {svg.lines.map((line) => (
                      <g key={`${line.from}-${line.to}`}>
                        <line
                          x1={line.x1}
                          y1={line.y1}
                          x2={line.x2}
                          y2={line.y2}
                          stroke="#3f7bbf"
                          strokeDasharray="4 3"
                          strokeWidth="1.5"
                        />
                        <text
                          x={(line.x1 + line.x2) / 2}
                          y={(line.y1 + line.y2) / 2 - 4}
                          className="gb-chart-axis"
                        >
                          {line.km} km
                        </text>
                      </g>
                    ))}
                    {svg.points.map((point) => (
                      <g key={point.id}>
                        <circle cx={point.sx} cy={point.sy} r="6" fill="#ffd166" stroke="#1e3a5f" strokeWidth="1.5" />
                        <text x={point.sx + 9} y={point.sy + 4} className="gb-chart-axis">
                          {point.code}
                        </text>
                      </g>
                    ))}
                  </svg>
                  <p className="gb-hint">
                    虚线为台站间距最大的三条连线；实算孔径 {activeSummary.computedApertureKm} km，登记孔径{' '}
                    {activeSummary.recordedApertureKm} km，平均台间距 {activeSummary.meanSpacingKm} km。
                  </p>
                </>
              )}
            </Card>
          </Col>

          <Col xs={24} xl={10}>
            <Card className="gb-panel" size="small" title="台阵几何与标定结论">
              <Descriptions column={1} size="small" bordered>
                <Descriptions.Item label="台阵">{activeSummary.arrayName}</Descriptions.Item>
                <Descriptions.Item label="运行状态">
                  <Tag color={activeSummary.state === '运行中' ? 'green' : 'orange'}>{activeSummary.state}</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="管理部门">{activeSummary.department || '未填写'}</Descriptions.Item>
                <Descriptions.Item label="布设 / 投运日期">
                  {activeSummary.deployDate} /{' '}
                  {activeSummary.state === '建设中' ? (
                    <span className="gb-hint">未投运</span>
                  ) : activeSummary.commissionDate ? (
                    <b>{activeSummary.commissionDate}</b>
                  ) : (
                    <Tag color="orange">待核定</Tag>
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="台站 / 仪器 / 在账">
                  {activeSummary.stationCount} / {activeSummary.instrumentCount} /{' '}
                  <b>{activeSummary.ledgerCount}</b>
                </Descriptions.Item>
                <Descriptions.Item label="登记 / 实算孔径">
                  {activeSummary.recordedApertureKm} km / <b>{activeSummary.computedApertureKm} km</b>
                </Descriptions.Item>
                <Descriptions.Item label="最大 / 最小台间距">
                  {activeSummary.maxPair
                    ? `${activeSummary.maxPair.fromCode} ↔ ${activeSummary.maxPair.toCode} ${activeSummary.maxPair.km} km`
                    : '—'}{' '}
                  / {activeSummary.minSpacingKm} km
                </Descriptions.Item>
                <Descriptions.Item label="几何中心">
                  {activeSummary.center
                    ? `${activeSummary.center.lat}, ${activeSummary.center.lng}（${bearingDeg(
                        activeSummary.center,
                        activeStations[0] ?? activeSummary.center
                      )}° 方位至首站）`
                    : '—'}
                </Descriptions.Item>
                <Descriptions.Item label="累计标定 / 不合格">
                  {activeSummary.calibrationCount} 次 /{' '}
                  <span className={activeSummary.unqualifiedCount > 0 ? 'gb-danger' : ''}>
                    {activeSummary.unqualifiedCount} 次
                  </span>
                </Descriptions.Item>
                <Descriptions.Item label="超期 / 按期标定率 / 待核">
                  {activeSummary.overdueCount} 台 / <b>{activeSummary.onScheduleRate}%</b> /{' '}
                  {activeSummary.unresolvedCount} 台
                </Descriptions.Item>
                <Descriptions.Item label="未闭环更换">{activeSummary.pendingReplaceCount} 条</Descriptions.Item>
                <Descriptions.Item label="结论">{activeSummary.conclusion}</Descriptions.Item>
              </Descriptions>
            </Card>

            <Card className="gb-panel" size="small" title="台站辐射距离（相对几何中心）" style={{ marginTop: 14 }}>
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                className="gb-table-compact"
                dataSource={radial}
                locale={{ emptyText: <EmptyPanel title="暂无台站" description="该台阵还没有台站。" compact /> }}
                columns={[
                  { title: '台站码', dataIndex: 'code', width: 110, className: 'gb-mono' },
                  {
                    title: '距几何中心 (km)',
                    dataIndex: 'km',
                    align: 'right',
                    render: (value: number) => <span className="gb-mono">{round(value, 3)}</span>,
                  },
                ]}
              />
            </Card>
          </Col>
        </Row>
      )}

      <Card className="gb-panel" size="small" title="台阵几何与标定结论汇总（全部台阵）">
        <Table
          rowKey="arrayId"
          size="small"
          className="gb-table-compact"
          dataSource={summaries}
          pagination={false}
          locale={{ emptyText: <EmptyPanel title="暂无台阵" description="新建台阵后自动生成几何汇总。" compact /> }}
          columns={[
            { title: '台阵', dataIndex: 'arrayName', width: 160 },
            { title: '状态', dataIndex: 'state', width: 90, render: (value: string) => <Tag>{value}</Tag> },
            {
              title: '布设/投运',
              width: 190,
              render: (_: unknown, row) => (
                <span className="gb-mono">
                  {row.deployDate}
                  <br />
                  {row.state === '建设中' ? (
                    <span className="gb-hint">未投运</span>
                  ) : row.commissionDate ? (
                    row.commissionDate
                  ) : (
                    <Tag color="orange">待核定</Tag>
                  )}
                </span>
              ),
            },
            { title: '台站 / 仪器 / 在账', width: 150, align: 'right', render: (_: unknown, row) => (
              <span className="gb-mono">{row.stationCount} / {row.instrumentCount} / {row.ledgerCount}</span>
            ) },
            {
              title: '实算孔径 (km)',
              dataIndex: 'computedApertureKm',
              width: 120,
              align: 'right',
              className: 'gb-mono',
            },
            {
              title: '平均台间距 (km)',
              dataIndex: 'meanSpacingKm',
              width: 130,
              align: 'right',
              className: 'gb-mono',
            },
            { title: '标定', dataIndex: 'calibrationCount', width: 80, align: 'right', className: 'gb-mono' },
            {
              title: '不合格',
              dataIndex: 'unqualifiedCount',
              width: 80,
              align: 'right',
              render: (value: number) => <span className={value > 0 ? 'gb-danger gb-mono' : 'gb-mono'}>{value}</span>,
            },
            {
              title: '超期台数',
              dataIndex: 'overdueCount',
              width: 90,
              align: 'right',
              render: (value: number) => <span className={value > 0 ? 'gb-danger gb-mono' : 'gb-mono'}>{value}</span>,
            },
            {
              title: '按期标定率',
              dataIndex: 'onScheduleRate',
              width: 100,
              align: 'right',
              render: (value: number) => (
                <span className={value < 100 ? 'gb-danger gb-mono' : 'gb-mono'}>{value}%</span>
              ),
            },
            {
              title: '待核',
              dataIndex: 'unresolvedCount',
              width: 70,
              align: 'right',
              render: (value: number) => <span className={value > 0 ? 'gb-danger gb-mono' : 'gb-mono'}>{value}</span>,
            },
            { title: '结论', dataIndex: 'conclusion', ellipsis: true },
          ]}
        />
      </Card>

      <Card
        className="gb-panel"
        size="small"
        title="两侧对账：布设班组（台站 / 安装位 / 安装日期） ↔ 台网中心（台阵状态 / 投运日期）"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="按台站码（忽略大小写与首尾空格）对账：对得上才投运起算；对不上的分别单列。投运日期由台网中心核定，采用后不回退；对账失败仅可重试布设班组侧。"
          />
          <Space wrap>
            <Input.TextArea
              value={networkText}
              onChange={(event) => setNetworkText(event.target.value)}
              placeholder='粘贴台网中心侧台账 JSON：[{"code":"LTX01","arrayState":"运行中","commissionDate":"2021-07-27"}, ...]'
              autoSize={{ minRows: 4, maxRows: 10 }}
              style={{ width: 620, fontFamily: 'monospace', fontSize: 12 }}
            />
          </Space>
          <Space wrap>
            <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleReconcile}>
              按台站码对账
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void handleRetryLocal()}>
              重试布设班组侧
            </Button>
            <Button onClick={() => setNetworkText(buildDemoNetworkRoster())}>填入示例台账</Button>
            <Button onClick={() => void handleApplyNetwork()}>采用台网中心核定（不回退）</Button>
          </Space>

          {reconcileResult ? (
            <>
              <Space wrap>
                <StatBadge label="两侧匹配" value={reconcileResult.matched.length} suffix="个" size="small" tone="success" />
                <StatBadge label="状态 / 日期异常" value={reconcileResult.exceptions.length} suffix="个" size="small" tone="warning" />
                <StatBadge label="仅本库有" value={reconcileResult.localOnly.length} suffix="个" size="small" tone="info" />
                <StatBadge label="仅台网中心有" value={reconcileResult.networkOnly.length} suffix="个" size="small" tone="danger" />
              </Space>
              {reconcileResult.localOnly.length > 0 ? (
                <Alert
                  type="warning"
                  showIcon
                  message={`${reconcileResult.localOnly.length} 个台站仅布设班组侧有记录，台网中心未返回——已单列，暂不据其核定投运`}
                />
              ) : null}
              {reconcileResult.networkOnly.length > 0 ? (
                <Alert
                  type="error"
                  showIcon
                  message={`${reconcileResult.networkOnly.length} 个台站仅台网中心侧有记录，本库对不上——已单列，请布设班组核对台站码后点「重试布设班组侧」`}
                />
              ) : null}
              <Table
                rowKey={(item) => `${item.key}-${item.issue}`}
                size="small"
                className="gb-table-compact"
                pagination={false}
                dataSource={reconcileResult.all}
                columns={reconcileColumns}
              />
            </>
          ) : (
            <EmptyPanel
              title="尚未对账"
              description="粘贴台网中心侧台站投运台账 JSON（或填入示例），按台站码核对两侧状态与投运日期。"
              compact
            />
          )}
        </Space>
      </Card>

      <Card className="gb-panel" size="small" title="结构版本与全量 JSON 导入导出">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap>
            <span className="gb-hint">导入模式：</span>
            <Radio.Group value={overwriteOnImport} onChange={(event) => setOverwriteOnImport(event.target.value)}>
              <Radio value={true}>覆盖（先清空本地数据）</Radio>
              <Radio value={false}>追加（重新分配 id）</Radio>
            </Radio.Group>
          </Space>
          <Space wrap>
            <Upload
              fileList={fileList}
              maxCount={1}
              accept="application/json"
              beforeUpload={() => false}
              onChange={({ fileList: list }) => setFileList(list)}
            >
              <Button icon={<UploadOutlined />}>选择 JSON 文件</Button>
            </Upload>
            <Button type="primary" icon={<UploadOutlined />} loading={busy} onClick={() => void handleImport()}>
              开始导入
            </Button>
            <Button icon={<DownloadOutlined />} onClick={() => void handleExport()}>
              导出当前数据
            </Button>
            <Button danger onClick={() => void handleReset()}>
              清空并重建演示数据
            </Button>
          </Space>
          <Descriptions column={3} size="small" bordered>
            <Descriptions.Item label="本地库名">{DB_NAME}</Descriptions.Item>
            <Descriptions.Item label="结构版本">v{DB_VERSION}</Descriptions.Item>
            <Descriptions.Item label="浏览器记录版本">v{stampedVersion}</Descriptions.Item>
            <Descriptions.Item label="台阵 / 台站">{counts.arrays} / {counts.stations}</Descriptions.Item>
            <Descriptions.Item label="仪器 / 标定">{counts.instruments} / {counts.calibrations}</Descriptions.Item>
            <Descriptions.Item label="更换记录">{counts.replaces}</Descriptions.Item>
            <Descriptions.Item label="最近备份时间" span={3}>
              {lastBackupAt ? new Date(lastBackupAt).toLocaleString('zh-CN') : '尚未备份'}
            </Descriptions.Item>
          </Descriptions>
          <p className="gb-hint">
            数据仅保存在当前浏览器 IndexedDB（{DB_NAME}）中，换浏览器或清空站点数据后不会自动跟随，请通过 JSON
            备份迁移。导出内容包含 arrays / stations / instruments / calibrations / replaces 五张表。
          </p>
        </Space>
      </Card>

      <p className="gb-hint">
        提示：孔径按台站两两 Haversine 距离的最大值实算；如需刷新台阵登记孔径，可到「台站仪器」页点击「重算孔径」。
      </p>
    </div>
  );
}
