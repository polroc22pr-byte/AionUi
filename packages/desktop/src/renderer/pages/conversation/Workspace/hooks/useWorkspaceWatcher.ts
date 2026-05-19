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
  const subscribedDirsRef = useRef<Set<string>>(new Set());
  const isReadyRef = useRef(false);
  const expandedKeysRef = useRef(expandedKeys);
  expandedKeysRef.current = expandedKeys;

  const subscribe = useCallback(
    (dirs: string[]) => {
      if (!workspace || dirs.length === 0) return;
      const newDirs = dirs.filter((d) => !subscribedDirsRef.current.has(d));
      if (newDirs.length === 0) return;
      wsSend('workspace.subscribe', { workspace, dirs: newDirs });
      for (const d of newDirs) subscribedDirsRef.current.add(d);
    },
    [workspace]
  );

  const unsubscribe = useCallback(
    (dirs: string[]) => {
      if (!workspace || dirs.length === 0) return;
      const existing = dirs.filter((d) => subscribedDirsRef.current.has(d));
      if (existing.length === 0) return;
      wsSend('workspace.unsubscribe', { workspace, dirs: existing });
      for (const d of existing) {
        subscribedDirsRef.current.delete(d);
        for (const sub of subscribedDirsRef.current) {
          if (sub.startsWith(d + '/')) {
            subscribedDirsRef.current.delete(sub);
          }
        }
      }
    },
    [workspace]
  );

  const resubscribeAll = useCallback(() => {
    const dirs = [...subscribedDirsRef.current];
    if (dirs.length > 0 && workspace) {
      wsSend('workspace.subscribe', { workspace, dirs });
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
      }

      for (const path of pathsModified) {
        emitter.emit('workspace.file.modified' as any, { workspace, relativePath: path });
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
      if (subscribedDirsRef.current.size > 0) {
        wsSend('workspace.unsubscribe', { workspace, dirs: [...subscribedDirsRef.current] });
        subscribedDirsRef.current.clear();
      }
    };
  }, [workspace, applyChanges, refreshWorkspace, resubscribeAll]);

  useEffect(() => {
    if (!workspace) return;
    if (collapsed) {
      if (subscribedDirsRef.current.size > 0) {
        wsSend('workspace.unsubscribe', { workspace, dirs: [...subscribedDirsRef.current] });
        subscribedDirsRef.current.clear();
      }
      isReadyRef.current = false;
      return;
    }
    if (!isReadyRef.current) {
      isReadyRef.current = true;
      subscribe(['', ...expandedKeysRef.current.filter((k) => k !== '')]);
    }
  }, [workspace, collapsed, subscribe]);

  const onDirsExpand = useCallback(
    (dirs: string[]) => {
      subscribe(dirs);
    },
    [subscribe]
  );

  const onDirsCollapse = useCallback(
    (dirs: string[]) => {
      unsubscribe(dirs);
    },
    [unsubscribe]
  );

  return { onDirsExpand, onDirsCollapse };
}
