import { Router } from 'express';
import { scanProject, scanDirectory } from '../meta/scanner.js';
import { extractAll } from '../meta/extractor.js';
import { registerProject } from '../meta/registrar.js';
import type { ScanOptions, ScanResult, ScannedFile } from '../meta/scanner.js';
import type { ExtractionResult } from '../meta/extractor.js';
import type { RegistrationResult } from '../meta/registrar.js';

const router = Router();

// POST /api/meta/scan — Clone and scan a GitHub project (or local dir)
router.post('/scan', async (req, res) => {
  try {
    const { url, directory, options } = req.body;
    
    if (!url && !directory) {
      return res.status(400).json({ success: false, error: 'Either url or directory is required' });
    }

    let result: ScanResult | { files: ScannedFile[]; error?: string };
    
    if (url) {
      result = await scanProject(url, options as ScanOptions);
    } else {
      const { files, error } = await scanDirectory(directory, options as ScanOptions);
      // scanDirectory returns { files, error } not ScanResult, so wrap inline
      if (error) {
        return res.json({ success: false, error, files, cleanedUp: true });
      }
      return res.json({ success: true, files, cleanedUp: true });
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// POST /api/meta/extract — Extract agents/skills from scanned files
router.post('/extract', (req, res) => {
  try {
    const { files } = req.body;
    
    if (!files || !Array.isArray(files)) {
      return res.status(400).json({ success: false, error: 'files array is required' });
    }

    const result: ExtractionResult = extractAll(files as ScannedFile[]);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// POST /api/meta/register — Register extracted agents/skills
router.post('/register', (req, res) => {
  try {
    const { projectName, projectUrl, agents, skills } = req.body;
    
    if (!projectName || !projectUrl) {
      return res.status(400).json({ success: false, error: 'projectName and projectUrl are required' });
    }

    const result: RegistrationResult = registerProject(
      projectName,
      projectUrl,
      agents || [],
      skills || [],
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

export default router;
