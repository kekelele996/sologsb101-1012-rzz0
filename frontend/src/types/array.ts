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
  /** 布设日期（布设班组登记） */
  deployDate: string;
  /**
   * 投运日期（台网中心核定，YYYY-MM-DD）。
   * 台阵转为「运行中」时由台网中心填写；建设中为空。
   * 标定周期从投运日起算；旧数据缺失时升级按最早安装日期补，补不出的单列待核。
   */
  commissionDate?: string;
  /** 运行状态（台网中心核定） */
  state: ArrayState;
  /** 管理部门 */
  department: string;
  createdAt: number;
  updatedAt: number;
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
