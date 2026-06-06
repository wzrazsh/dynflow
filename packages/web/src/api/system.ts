import { get } from './client';
import type { ApiResponse, SystemInfo } from '@dynflow/shared';

export function fetchSystemInfo(): Promise<ApiResponse<SystemInfo>> {
  return get<ApiResponse<SystemInfo>>('/system/info');
}
