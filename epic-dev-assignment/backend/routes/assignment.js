import express from 'express';
import { sendServerError } from '../utils/httpError.js';
import { autoAssignStories, reassignStory } from '../services/assignmentService.js';

const router = express.Router();

// POST /api/auto-assign - Auto-assign stories to developers
router.post('/auto-assign', async (req, res) => {
  try {
    const { epics, developers } = req.body;

    if (!epics || !Array.isArray(epics)) {
      return res.status(400).json({ success: false, error: 'Epics array is required' });
    }
    if (!developers || !Array.isArray(developers)) {
      return res.status(400).json({ success: false, error: 'Developers array is required' });
    }
    if (epics.length === 0) {
      return res.status(400).json({ success: false, error: 'No epics to assign' });
    }
    if (developers.length === 0) {
      return res.status(400).json({ success: false, error: 'No developers available' });
    }

    const result = await autoAssignStories(epics, developers);
    res.json(result);
  } catch (error) {
    console.error('Error auto-assigning stories:', error);
    sendServerError(res, error, 'Failed to auto-assign stories');
  }
});

// POST /api/reassign - Manually reassign a story
// Accepts either:
//   Full form: { assignments, storyId, newDeveloperUsername, workloadDistribution, developers }
//   Simple form: { story_id, new_developer, developers } (from project Assign page)
router.post('/reassign', async (req, res) => {
  try {
    const {
      assignments, workloadDistribution, developers,
      storyId: _storyId, story_id: _story_id,
      // Legacy epic-level fields still accepted
      epicId: _epicId, epic_id: _epic_id,
      newDeveloperUsername: _newDev, new_developer: _new_dev,
    } = req.body;

    const storyId = _storyId || _story_id || _epicId || _epic_id;
    const newDeveloperUsername = _newDev || _new_dev;

    if (!storyId || !newDeveloperUsername) {
      return res.status(400).json({
        success: false,
        error: 'storyId (or story_id) and newDeveloperUsername (or new_developer) are required'
      });
    }

    // Full form: use reassignStory service
    if (assignments && workloadDistribution) {
      const result = reassignStory(assignments, storyId, newDeveloperUsername, workloadDistribution, developers);
      return res.json(result);
    }

    // Simple form: return the new assignment fields directly
    const dev = (developers || []).find(d => (d.login || d.username) === newDeveloperUsername);
    res.json({
      success: true,
      story_id: storyId,
      assigned_developer: newDeveloperUsername,
      developer: {
        username: newDeveloperUsername,
        expertise: dev?.primary_expertise || dev?.analysis?.expertise?.primary || 'Full Stack',
        experienceLevel: dev?.experience_level || dev?.analysis?.experienceLevel?.level || 'Junior',
      },
      confidence: 'manual',
    });
  } catch (error) {
    console.error('Error reassigning story:', error);
    sendServerError(res, error, 'Failed to reassign story');
  }
});

export default router;
