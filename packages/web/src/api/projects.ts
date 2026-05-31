import { get, post } from './client';
import type { ProjectMeta, ProjectDetail, VersionMeta, RunResponse, FileReadResponse } from '@dynflow/shared';

export function fetchProjects(): Promise<ProjectMeta[]> {
  return get<ProjectMeta[]>('/projects');
}

export function fetchProject(name: string): Promise<ProjectDetail> {
  return get<ProjectDetail>(`/projects/${encodeURIComponent(name)}`);
}

export function fetchVersions(name: string): Promise<VersionMeta[]> {
  return get<VersionMeta[]>(`/projects/${encodeURIComponent(name)}/versions`);
}

export function fetchVersion(name: string, version: number): Promise<VersionMeta> {
  return get<VersionMeta>(`/projects/${encodeURIComponent(name)}/versions/${version}`);
}

export function readFile(name: string, version: number, path: string): Promise<FileReadResponse> {
  return post<FileReadResponse>(`/projects/${encodeURIComponent(name)}/versions/${version}/read`, { path });
}

export function runProject(name: string, prompt: string): Promise<RunResponse> {
  return post<RunResponse>(`/projects/${encodeURIComponent(name)}/run`, { prompt });
}

export function approveVersion(name: string, version: number): Promise<void> {
  return post<void>(`/projects/${encodeURIComponent(name)}/versions/${version}/approve`, {});
}
