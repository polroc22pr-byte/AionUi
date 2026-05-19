import { ipcBridge } from '@/common';
import type { IDirOrFile, WorkspaceChange } from '@/common/adapter/ipcBridge';
import { workspaceWatcher } from '@/common/adapter/ipcBridge';
import { wsSend, wsOnReconnect } from '@/common/adapter/httpBridge';
import { emitter } from '@/renderer/utils/emitter';
import { useCallback, useEffect, useRef } from 'react';

interface UseWorkspaceWatcherOptions {
  workspace: string;
  conversation_id: string;
  expandedKeys: string[];
  collapsed: boolean;
  setFiles: React.Dispatch<React.SetStateAction<IDirOrFile[]>>;
  refreshWorkspace: () => void;
}

function removeNodes(tree: IDirOrFile[], pathsToDelete: Set<string>): IDirOrFile[] {
  return tree
    .filter((node) => !pathsToDelete.has(node.relativePath))
    .map((node) => {
      if (node.children && node.children.length > 0) {
        const filtered = removeNodes(node.children, pathsToDelete);
        if (filtered.length !== node.children.length) {
          return { ...node, children: filtered };
        }
      }
      return node;
    });
}

function replaceChildren(tree: IDirOrFile[], parentRelPath: string, newChildren: IDirOrFile[]): IDirOrFile[] {
  return tree.map((node) => {
    if (node.relativePath === parentRelPath && node.isDir) {
      return { ...node, children: newChildren };
    }
    if (node.children && node.children.length > 0) {
      const updated = replaceChildren(node.children, parentRelPath, newChildren);
      if (updated !== node.children) {
        return { ...node, children: updated };
      }
    }
    return node;
  });
}

export function useWorkspaceWatcher(options: UseWorkspaceWatcherOptions) {
  const { workspace, conversation_id, expandedKeys, collapsed, setFiles, refreshWorkspace } = options;
  const treeSubscribedDirs = useRef<Set<string>>(new Set());
  const previewSubscribedDirs = useRef<Set<string>>(new Set());
  const isReadyRef = useRef(false);
  const expandedKeysRef = useRef(expandedKeys);
  expandedKeysRef.current = expandedKeys;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  const actualSubscribe = useCallback(
    (dirs: string[]) => {
      if (!workspace || dirs.length === 0) return;
      const newDirs = dirs.filter((d) => !treeSubscribedDirs.current.has(d) && !previewSubscribedDirs.current.has(d));
      if (newDirs.length > 0) {
        wsSend('workspace.subscribe', { workspace, dirs: newDirs });
      }
    },
    [workspace]
  );

  const actualUnsubscribe = useCallback(
    (dirs: string[]) => {
      if (!workspace || dirs.length === 0) return;
      const toUnsub = dirs.filter((d) => !treeSubscribedDirs.current.has(d) && !previewSubscribedDirs.current.has(d));
      if (toUnsub.length > 0) {
        wsSend('workspace.unsubscribe', { workspace, dirs: toUnsub });
      }
    },
    [workspace]
  );

  const resubscribeAll = useCallback(() => {
    const allDirs = new Set([...treeSubscribedDirs.current, ...previewSubscribedDirs.current]);
    if (allDirs.size > 0 && workspace) {
      wsSend('workspace.subscribe', { workspace, dirs: [...allDirs] });
    }
  }, [workspace]);

  const applyChanges = useCallback(
    (changes: WorkspaceChange[]) => {
      const dirsToRefetch = new Set<string>();
      const pathsToDelete = new Set<string>();
      const pathsModified: string[] = [];

      for (const change of changes) {
        const lastSlash = change.path.lastIndexOf('/');
        const parentDir = lastSlash >= 0 ? change.path.substring(0, lastSlash) : '';

        switch (change.kind) {
          case 'delete':
            pathsToDelete.add(change.path);
            break;
          case 'modify':
            pathsModified.push(change.path);
            break;
          case 'create':
          case 'rename':
            dirsToRefetch.add(parentDir);
            break;
        }
      }

      if (pathsToDelete.size > 0) {
        setFiles((prev) => removeNodes(prev, pathsToDelete));
        for (const path of pathsToDelete) {
          emitter.emit('workspace.file.deleted', { workspace, relativePath: path });
        }
      }

      for (const path of pathsModified) {
        emitter.emit('workspace.file.modified', { workspace, relativePath: path });
      }

      for (const dir of dirsToRefetch) {
        const fullPath = dir ? `${workspace}/${dir}` : workspace;
        void ipcBridge.conversation.getWorkspace
          .invoke({ path: fullPath, workspace, conversation_id, search: '' })
          .then((res: IDirOrFile[]) => {
            if (!res || res.length === 0) return;
            if (dir === '') {
              setFiles(res);
            } else {
              const newChildren = res[0]?.children;
              if (!newChildren) return;
              setFiles((prev) => replaceChildren(prev, dir, newChildren));
            }
          });
      }
    },
    [workspace, conversation_id, setFiles]
  );

  useEffect(() => {
    if (!workspace) return;

    const unsubChanged = workspaceWatcher.changed.on((event) => {
      if (event.workspace !== workspace) return;
      applyChanges(event.changes);
    });

    const unsubOverflow = workspaceWatcher.overflow.on((event) => {
      if (event.workspace !== workspace) return;
      refreshWorkspace();
    });

    const removeReconnect = wsOnReconnect(resubscribeAll);

    return () => {
      unsubChanged();
      unsubOverflow();
      removeReconnect();
      const allDirs = new Set([...treeSubscribedDirs.current, ...previewSubscribedDirs.current]);
      if (allDirs.size > 0) {
        wsSend('workspace.unsubscribe', { workspace, dirs: [...allDirs] });
      }
      treeSubscribedDirs.current.clear();
      previewSubscribedDirs.current.clear();
    };
  }, [workspace, applyChanges, refreshWorkspace, resubscribeAll]);

  useEffect(() => {
    if (!workspace) return;
    if (collapsed) {
      isReadyRef.current = false;
      return;
    }
    if (!isReadyRef.current) {
      isReadyRef.current = true;
      const dirs = ['', ...expandedKeysRef.current.filter((k) => k !== '')];
      for (const d of dirs) treeSubscribedDirs.current.add(d);
      actualSubscribe(dirs);
      emitter.emit('workspace.preview.refetch', { workspace });
    }
  }, [workspace, collapsed, actualSubscribe]);

  useEffect(() => {
    const handleSub = ({ workspace: ws, dir }: { workspace: string; dir: string }) => {
      if (ws !== workspaceRef.current) return;
      previewSubscribedDirs.current.add(dir);
      actualSubscribe([dir]);
    };
    const handleUnsub = ({ workspace: ws, dir }: { workspace: string; dir: string }) => {
      if (ws !== workspaceRef.current) return;
      previewSubscribedDirs.current.delete(dir);
      actualUnsubscribe([dir]);
    };
    emitter.on('workspace.preview.subscribe', handleSub);
    emitter.on('workspace.preview.unsubscribe', handleUnsub);
    return () => {
      emitter.off('workspace.preview.subscribe', handleSub);
      emitter.off('workspace.preview.unsubscribe', handleUnsub);
    };
  }, [actualSubscribe, actualUnsubscribe]);

  const onDirsExpand = useCallback(
    (dirs: string[]) => {
      for (const d of dirs) treeSubscribedDirs.current.add(d);
      actualSubscribe(dirs);
    },
    [actualSubscribe]
  );

  const onDirsCollapse = useCallback(
    (dirs: string[]) => {
      for (const d of dirs) {
        treeSubscribedDirs.current.delete(d);
        for (const sub of treeSubscribedDirs.current) {
          if (sub.startsWith(d + '/')) {
            treeSubscribedDirs.current.delete(sub);
          }
        }
      }
      actualUnsubscribe(dirs);
    },
    [actualUnsubscribe]
  );

  return { onDirsExpand, onDirsCollapse };
}
