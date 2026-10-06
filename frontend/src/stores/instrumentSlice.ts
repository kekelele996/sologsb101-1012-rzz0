/**
 * 仪器 slice：维护仪器列表、登记草稿与选中台站。
 * 序列号唯一性校验与「登记后自动生成下一次标定待办」在本 slice 的动作里完成。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type { Instrument, InstrumentDraft, InstrumentState, InstrumentType } from '@/types/instrument';
import { createEmptyInstrumentDraft } from '@/types/instrument';
import { buildInstrumentLedger } from '@/utils/reconcile';
import type { RootState } from '@/stores/store';

/** 选择器入参统一用 RootState */
type WithInstrument = RootState;

export interface InstrumentSliceState {
  instruments: Instrument[];
  ready: boolean;
  error: string | null;
  /** 当前选中的台站（台站仪器页上下文） */
  currentStationId: string | null;
  /** 仪器登记草稿（跨页面保留） */
  draft: InstrumentDraft;
  /** 最近一次保存回执（用于页面提示） */
  lastReceipt: string;
}

const initialState: InstrumentSliceState = {
  instruments: [],
  ready: false,
  error: null,
  currentStationId: null,
  draft: createEmptyInstrumentDraft(),
  lastReceipt: '',
};

/** 序列号唯一性校验：返回冲突的仪器（排除自身） */
export async function findSerialConflict(
  serialNo: string,
  excludeId?: string
): Promise<Instrument | undefined> {
  const rows = await db.instruments.where('serialNo').equals(serialNo).toArray();
  return rows.find((row) => row.id !== excludeId);
}

export const createInstrument = createAsyncThunk(
  'instrument/createInstrument',
  async (
    payload: Omit<Instrument, 'id' | 'createdAt' | 'updatedAt'>,
    { rejectWithValue }
  ) => {
    const conflict = await findSerialConflict(payload.serialNo);
    if (conflict) {
      return rejectWithValue(`序列号「${payload.serialNo}」已被仪器 ${conflict.model} 占用`);
    }
    const now = Date.now();
    const row: Instrument = { ...payload, id: createId('ins'), createdAt: now, updatedAt: now };
    await db.instruments.put(row);
    // 登记后按统一在账口径生成下一次标定待办：建设中台阵不进周期；
    // 运行中缺投运日期的单列待核，不冒进超期名单。
    const [arrays, stations, instruments, calibrations] = await Promise.all([
      db.arrays.toArray(),
      db.stations.toArray(),
      db.instruments.toArray(),
      db.calibrations.toArray(),
    ]);
    const { entries } = buildInstrumentLedger(arrays, stations, instruments, calibrations, now);
    const entry = entries.find((item) => item.instrument.id === row.id);
    let receipt: string;
    if (!entry?.info.running) {
      receipt = '仪器已登记：所属台阵仍在建设中，暂不纳入在账台数与标定周期，投运后起算';
    } else if (entry.unresolved) {
      receipt = '仪器已登记：台阵投运日期缺失，已单列待核，暂不计入在账与超期名单';
    } else if (entry.dueInDays >= 0) {
      receipt = `仪器已登记，标定周期自投运日起算，距下次标定 ${entry.dueInDays} 天`;
    } else {
      receipt = `仪器已登记，按投运日起算已超过标定周期 ${Math.abs(entry.dueInDays)} 天，请尽快安排标定`;
    }
    return { row, receipt };
  }
);

export const updateInstrument = createAsyncThunk(
  'instrument/updateInstrument',
  async (
    payload: { id: string; patch: Partial<Instrument> },
    { rejectWithValue }
  ) => {
    if (payload.patch.serialNo) {
      const conflict = await findSerialConflict(payload.patch.serialNo, payload.id);
      if (conflict) {
        return rejectWithValue(`序列号「${payload.patch.serialNo}」已被占用`);
      }
    }
    await db.instruments.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

/** 删除仪器：级联删除标定与更换记录 */
export const removeInstrument = createAsyncThunk(
  'instrument/removeInstrument',
  async (instrumentId: string) => {
    await db.transaction('rw', [db.instruments, db.calibrations, db.replaces], async () => {
      await db.calibrations.where('instrumentId').equals(instrumentId).delete();
      await db.replaces.where('instrumentId').equals(instrumentId).delete();
      await db.instruments.delete(instrumentId);
    });
    return instrumentId;
  }
);

/** 批量改状态（如把超期仪器统一置为待标定） */
export const bulkSetInstrumentState = createAsyncThunk(
  'instrument/bulkSetInstrumentState',
  async (payload: { ids: string[]; state: InstrumentState }) => {
    const now = Date.now();
    await db.instruments
      .where('id')
      .anyOf(payload.ids)
      .modify((row) => {
        row.state = payload.state;
        row.updatedAt = now;
      });
    return payload;
  }
);

/** 更换完成后回写仪器序列号并置为在用 */
export const applySerialReplace = createAsyncThunk(
  'instrument/applySerialReplace',
  async (payload: { instrumentId: string; newSerialNo: string }) => {
    await db.instruments.update(payload.instrumentId, {
      serialNo: payload.newSerialNo,
      state: '在用',
      updatedAt: Date.now(),
    } as never);
    return payload;
  }
);

const instrumentSlice = createSlice({
  name: 'instrument',
  initialState,
  reducers: {
    setInstruments(state, action: PayloadAction<Instrument[]>) {
      state.instruments = action.payload;
      state.ready = true;
      state.error = null;
    },
    setInstrumentError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    selectStationForInstrument(state, action: PayloadAction<string | null>) {
      state.currentStationId = action.payload;
      state.draft.stationId = action.payload ?? '';
    },
    patchDraft(state, action: PayloadAction<Partial<InstrumentDraft>>) {
      state.draft = { ...state.draft, ...action.payload };
    },
    resetDraft(state) {
      state.draft = { ...createEmptyInstrumentDraft(), stationId: state.currentStationId ?? '' };
    },
    setReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createInstrument.fulfilled, (state, action) => {
        state.lastReceipt = action.payload.receipt;
        state.error = null;
      })
      .addCase(createInstrument.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '仪器登记失败';
      })
      .addCase(updateInstrument.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '仪器更新失败';
      })
      .addCase(removeInstrument.fulfilled, (state, action) => {
        state.lastReceipt = `已删除仪器 ${action.payload}`;
      });
  },
});

export const {
  setInstruments,
  setInstrumentError,
  selectStationForInstrument,
  patchDraft,
  resetDraft,
  setReceipt,
} = instrumentSlice.actions;

let started = false;

/** 启动仪器表实时订阅（幂等） */
export function startInstrumentSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Instrument>(() => db.instruments).subscribe((rows) => {
    dispatch(setInstruments(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectInstrumentState = (state: WithInstrument): InstrumentSliceState => state.instrument;
export const selectInstruments = (state: WithInstrument): Instrument[] => state.instrument.instruments;
export const selectInstrumentReady = (state: WithInstrument): boolean => state.instrument.ready;
export const selectInstrumentDraft = (state: WithInstrument): InstrumentDraft => state.instrument.draft;
export const selectInstrumentReceipt = (state: WithInstrument): string => state.instrument.lastReceipt;

export const selectInstrumentById = (
  state: WithInstrument,
  id: string | null | undefined
): Instrument | null => (id ? state.instrument.instruments.find((row) => row.id === id) ?? null : null);

export const selectInstrumentsOfStation = (
  state: WithInstrument,
  stationId: string | null | undefined
): Instrument[] => {
  if (!stationId) return [];
  return state.instrument.instruments
    .filter((row) => row.stationId === stationId)
    .sort((a, b) => a.type.localeCompare(b.type, 'zh-Hans-CN') || a.model.localeCompare(b.model));
};

/** 台站 id → 仪器台数 */
export const selectInstrumentCountsByStation = (state: WithInstrument): Record<string, number> => {
  const counts: Record<string, number> = {};
  state.instrument.instruments.forEach((row) => {
    counts[row.stationId] = (counts[row.stationId] ?? 0) + 1;
  });
  return counts;
};

/** 仪器类型统计 */
export const selectInstrumentTypeCounts = (state: WithInstrument): Record<InstrumentType, number> => {
  const counts: Record<InstrumentType, number> = { 宽频带: 0, 短周期: 0, 强震: 0 };
  state.instrument.instruments.forEach((row) => {
    counts[row.type] += 1;
  });
  return counts;
};

export default instrumentSlice.reducer;
