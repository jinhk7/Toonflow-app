import { createRouter, createWebHashHistory } from "vue-router";
import { useHelloStore } from "@/stores/hello";
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      redirect: "/hello",
    },
    {
      path: "/hello",
      beforeEnter: async () => await useHelloStore().load() ? { path: "/home", replace: true } : true,
      component: () => import("@/pages/hello/index.vue"),
    },
    {
      path: "/home",
      component: () => import("@/pages/home/index.vue"),
    },
    {
      path: "/canvas",
      redirect: "/workspace",
    },
    {
      path: "/workspace",
      component: () => import("@/pages/workspace/index.vue"),
    },
    {
      path: "/mobile",
      component: () => import("@/pages/workspace/mobile/mobileLayout.vue"),
      children: [
        { path: "", component: () => import("@/pages/workspace/mobile/mobileProjects.vue") },
        { path: "workspace", component: () => import("@/pages/workspace/mobile/mobileWorkspace.vue") },
        { path: "node/:nodeId", component: () => import("@/pages/workspace/mobile/mobileNodeDetail.vue") },
        { path: "tasks", component: () => import("@/pages/workspace/mobile/mobileTasks.vue") },
      ],
    },
  ],
});
export default router;
