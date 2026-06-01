import { get, post } from './client';
import type { ApiResponse, ProjectMeta, VersionMeta, RunResponse, FileReadResponse } from '@dynflow/shared';

export async function fetchProjects(): Promise<ProjectMeta[]> {
  const res = await get<ApiResponse<ProjectMeta[]>>('/projects');
  return res.data ?? [];
}

export async function fetchProject(name: string): Promise<ProjectMeta> {
  const res = await get<ApiResponse<ProjectMeta>>(`/projects/${encodeURIComponent(name)}`);
  return res.data as ProjectMeta;
}

export async function fetchVersions(name: string): Promise<VersionMeta[]> {
  const res = await get<ApiResponse<VersionMeta[]>>(`/projects/${encodeURIComponent(name)}/versions`);
  return res.data ?? [];
}

export async function fetchVersion(name: string, version: number): Promise<VersionMeta> {
  const res = await get<ApiResponse<VersionMeta>>(`/projects/${encodeURIComponent(name)}/versions/${version}`);
  return res.data as VersionMeta;
}

export async function readFile(name: string, version: number, path: string): Promise<FileReadResponse> {
  const res = await post<ApiResponse<FileReadResponse>>(`/projects/${encodeURIComponent(name)}/versions/${version}/read`, { path });
  return res.data as FileReadResponse;
}

export async function runProject(name: string, prompt: string): Promise<RunResponse> {
  const res = await post<ApiResponse<RunResponse>>(`/projects/${encodeURIComponent(name)}/run`, { prompt });
  return res.data as RunResponse;
}

export async function approveVersion(name: string, version: number): Promise<void> {
  await post<ApiResponse<unknown>>(`/projects/${encodeURIComponent(name)}/versions/${version}/approve`, {});
}
