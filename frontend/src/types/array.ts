/** 台阵运行状态 */
export type ArrayState = '建设中' | '运行中' | '停测';

export const ARRAY_STATES: ArrayState[] = ['建设中', '运行中', '停测'];

/** 台阵：地震台阵建设与运维的基本单元 */
export interface SeisArray {
  id: string;
  /** 台阵名 */
  name: string;
  /** 孔径（km） */
  apertureKm: number;
  /** 台站数（由台站表汇总回写） */
  stationCount: number;
  /** 布设日期（布设班组维护） */
  deployDate: string;
  /** 运行状态（台网中心维护） */
  state: ArrayState;
  /**
   * 投运日期（台网中心维护，YYYY-MM-DD，空串表示尚未投运）。
   * 台阵转「运行中」且投运日期齐备后，旗下仪器才进在账台数与标定周期。
   */
  commissionDate: string;
  /** 管理部门 */
  department: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 在账口径：台阵「运行中」且台网中心已下发投运日期。
 * 未在账台阵的仪器不进在账台数、不进标定周期（超期名单与按期标定率同口径）。
 */
export function isArrayOnBook(
  array: Pick<SeisArray, 'state' | 'commissionDate'> | null | undefined
): boolean {
  return (
    !!array &&
    array.state === '运行中' &&
    typeof array.commissionDate === 'string' &&
    array.commissionDate.length > 0
  );
}

/**
 * 升级 / 导入旧数据时按安装日期回填投运日期：
 * - 运行中 / 停测的台阵取旗下仪器最早安装日期；
 * - 建设中的台阵尚未投运，留空；
 * - 无仪器可参照的留空（补不出，由对账面板单列，待台网中心补登）。
 */
export function deriveCommissionDate(
  array: Pick<SeisArray, 'id' | 'state'>,
  stations: Array<{ id: string; arrayId: string }>,
  instruments: Array<{ stationId: string; installDate: string }>
): string {
  if (array.state === '建设中') return '';
  const stationIds = new Set(
    stations.filter((station) => station.arrayId === array.id).map((station) => station.id)
  );
  const installDates = instruments
    .filter((instrument) => stationIds.has(instrument.stationId) && instrument.installDate)
    .map((instrument) => instrument.installDate)
    .sort();
  return installDates[0] ?? '';
}

/** 台阵台账筛选条件（存于 arraySlice，并同步 URL query） */
export interface ArrayFilterState {
  keyword: string;
  states: ArrayState[];
  /** 布设日期下限（YYYY-MM-DD） */
  deployFrom: string;
  /** 布设日期上限 */
  deployTo: string;
  /** 孔径下限（km） */
  minApertureKm: number | null;
  /** 孔径上限（km） */
  maxApertureKm: number | null;
}

export function createEmptyArrayFilter(): ArrayFilterState {
  return {
    keyword: '',
    states: [],
    deployFrom: '',
    deployTo: '',
    minApertureKm: null,
    maxApertureKm: null
  };
}

/** 孔径分档，供筛选下拉使用 */
export const APERTURE_BUCKETS: Array<{ label: string; min: number | null; max: number | null }> = [
  { label: '全部孔径', min: null, max: null },
  { label: '小于 5 km', min: null, max: 5 },
  { label: '5 ~ 20 km', min: 5, max: 20 },
  { label: '20 ~ 50 km', min: 20, max: 50 },
  { label: '大于 50 km', min: 50, max: null },
];
